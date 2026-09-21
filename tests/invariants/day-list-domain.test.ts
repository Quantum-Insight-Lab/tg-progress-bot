import { expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  addTaskToTodayList,
  createTask,
  openDayList,
  type Task,
} from "../../src/domain/tasks/index.js";

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
