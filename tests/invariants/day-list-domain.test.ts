import { expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  addTaskToTodayList,
  carryOverOpenItems,
  createTask,
  openDayList,
  type Task,
} from "../../src/domain/tasks/index.js";
import { EVENT_TYPES } from "../../src/events/generated/event-types.js";

function sampleTask(id: string, projectId: string): Task {
  return createTask({
    id,
    projectId,
    issueId: "issue-1",
    assigneeId: "u-a",
    title: "Шаг",
    createdByUserId: "u-a",
    target: "today",
    issue: { id: "issue-1", projectId },
    assignee: { projectId, userId: "u-a" },
    actor: { userId: "u-a", role: "member" },
    idempotencyKey: `${id}:created`,
  }).task;
}

it("INV-06: повторное открытие того же дня возвращает тот же список", () => {
  const first = openDayList({
    lists: [],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-1",
    topicId: null,
  });
  const second = openDayList({
    lists: [first.list],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-2",
    topicId: null,
  });
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.list.id).toBe("list-1");
});

it("INV-06: переполнение C-5 не заводит второй список", () => {
  const opened = openDayList({
    lists: [],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-1",
    topicId: null,
  });
  const items = Array.from(
    { length: constants.dayListMaxItems },
    (_, index) => ({
      id: `item-${String(index)}`,
      projectId: "proj-1",
      listId: opened.list.id,
      taskId: `task-${String(index)}`,
      position: index,
      isDone: false,
      carriedFromListId: null,
    }),
  );
  const full = { ...opened.list, items };
  try {
    addTaskToTodayList({
      list: full,
      task: sampleTask("task-new", "proj-1"),
      itemId: "item-new",
      openItemsForTask: [],
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("list_full");
  }
  const again = openDayList({
    lists: [full],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-2",
    topicId: null,
  });
  expect(again.list.id).toBe("list-1");
});

it("INV-07: домен отклоняет пункт с задачей другого проекта", () => {
  const list = openDayList({
    lists: [],
    projectId: "proj-1",
    listDate: "2026-09-22",
    newListId: "list-1",
    topicId: null,
  }).list;
  try {
    addTaskToTodayList({
      list,
      task: sampleTask("task-x", "other"),
      itemId: "item-1",
      openItemsForTask: [],
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_transition");
  }
});

it("INV-14: домен не ставит второй незакрытый пункт", () => {
  const list = openDayList({
    lists: [],
    projectId: "proj-1",
    listDate: "2026-09-23",
    newListId: "list-1",
    topicId: null,
  }).list;
  const task = sampleTask("task-1", "proj-1");
  const first = addTaskToTodayList({
    list,
    task,
    itemId: "item-1",
    openItemsForTask: [],
  });
  try {
    addTaskToTodayList({
      list: first.list,
      task,
      itemId: "item-2",
      openItemsForTask: first.list.items,
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_transition");
  }
});

function openOn(projectId: string, listDate: string, listId: string) {
  return openDayList({
    lists: [],
    projectId,
    listDate,
    newListId: listId,
    topicId: null,
  }).list;
}

it("INV-14: перенос закрывает старый пункт и оставляет один незакрытый", () => {
  const yesterday = addTaskToTodayList({
    list: openOn("proj-1", "2026-09-20", "list-1"),
    task: sampleTask("task-1", "proj-1"),
    itemId: "item-1",
    openItemsForTask: [],
  }).list;
  const today = openDayList({
    lists: [yesterday],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-2",
    topicId: null,
  });
  const carried = carryOverOpenItems({
    lists: [yesterday],
    targetList: today.list,
    itemIdFor: () => "item-2",
  });
  const yesterdayNow = carried.lists.find((list) => list.id === "list-1");
  const openItems = carried.lists.flatMap((list) =>
    list.items.filter((item) => !item.isDone),
  );
  expect(yesterdayNow?.items[0]?.isDone).toBe(true);
  expect(openItems).toHaveLength(1);
  expect(openItems[0]?.listId).toBe("list-2");
  expect(openItems[0]?.carriedFromListId).toBe("list-1");
  expect(carried.events).toHaveLength(1);
  expect(carried.events[0]?.type).toBe(EVENT_TYPES.TASK_CARRIED_OVER);
  expect(carried.events[0]?.payload.day_number).toBe(2);
  expect(carried.events[0]?.idempotencyKey).toBe("task-1:2026-09-21");
});

it("INV-14: повторный перенос на ту же дату не создаёт второй пункт", () => {
  const yesterday = addTaskToTodayList({
    list: openOn("proj-1", "2026-09-20", "list-1"),
    task: sampleTask("task-1", "proj-1"),
    itemId: "item-1",
    openItemsForTask: [],
  }).list;
  const today = openDayList({
    lists: [yesterday],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-2",
    topicId: null,
  }).list;
  const first = carryOverOpenItems({
    lists: [yesterday],
    targetList: today,
    itemIdFor: () => "item-2",
  });
  const second = carryOverOpenItems({
    lists: first.lists,
    targetList: first.targetList,
    itemIdFor: () => "item-3",
  });
  const openItems = second.lists.flatMap((list) =>
    list.items.filter((item) => !item.isDone),
  );
  expect(first.events).toHaveLength(1);
  expect(second.events).toHaveLength(0);
  expect(openItems).toHaveLength(1);
  expect(openItems[0]?.id).toBe("item-2");
});

it("INV-14: отмеченный пункт не переносится", () => {
  const opened = openOn("proj-1", "2026-09-20", "list-1");
  const withItem = addTaskToTodayList({
    list: opened,
    task: sampleTask("task-1", "proj-1"),
    itemId: "item-1",
    openItemsForTask: [],
  }).list;
  const yesterday = {
    ...withItem,
    items: withItem.items.map((item) => ({ ...item, isDone: true })),
  };
  const today = openDayList({
    lists: [yesterday],
    projectId: "proj-1",
    listDate: "2026-09-21",
    newListId: "list-2",
    topicId: null,
  }).list;
  const carried = carryOverOpenItems({
    lists: [yesterday],
    targetList: today,
    itemIdFor: () => "item-2",
  });
  expect(carried.events).toEqual([]);
  expect(carried.targetList.items).toEqual([]);
});
