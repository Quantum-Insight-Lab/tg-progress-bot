import { constants } from "../../config/index.js";
import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { DomainError } from "../shared/errors.js";
import { checkTask, type TaskCheckedEvent } from "./commands.js";
import type { BlockerResolvedEvent } from "./blockers.js";
import type { Blocker, ProjectActor, Task, TaskList, TaskListItem } from "./types.js";

export type TaskCarriedOverEvent = {
  type: typeof EVENT_TYPES.TASK_CARRIED_OVER;
  actor: { id: "system"; role: "system" };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.carried_over"];
  idempotencyKey: string;
};

/** INV-06: один список на пару проект + дата; повтор возвращает существующий. */
export function openDayList(input: {
  lists: readonly TaskList[];
  projectId: string;
  listDate: string;
  newListId: string;
  topicId: number | null;
}): { list: TaskList; created: boolean } {
  const existing = input.lists.find(
    (list) =>
      list.projectId === input.projectId && list.listDate === input.listDate,
  );
  if (existing !== undefined) {
    return { list: existing, created: false };
  }
  return {
    list: {
      id: input.newListId,
      projectId: input.projectId,
      listDate: input.listDate,
      topicId: input.topicId,
      messageId: null,
      items: [],
    },
    created: true,
  };
}

export function setListMessageId(list: TaskList, messageId: number): TaskList {
  return { ...list, messageId };
}

function hasOpenItemForTask(
  items: readonly TaskListItem[],
  taskId: string,
): boolean {
  return items.some((item) => item.taskId === taskId && !item.isDone);
}

/** INV-07, INV-14, C-5: пункт в существующий список, без второго сообщения. */
export function addTaskToTodayList(input: {
  list: TaskList;
  task: Task;
  itemId: string;
  openItemsForTask: readonly TaskListItem[];
}): { list: TaskList; item: TaskListItem } {
  if (input.task.projectId !== input.list.projectId) {
    throw new DomainError(
      "invalid_transition",
      "Пункт списка ссылается на задачу другого проекта",
    );
  }
  if (hasOpenItemForTask(input.openItemsForTask, input.task.id)) {
    throw new DomainError(
      "invalid_transition",
      "У задачи уже есть незакрытый пункт",
    );
  }
  if (hasOpenItemForTask(input.list.items, input.task.id)) {
    throw new DomainError(
      "invalid_transition",
      "У задачи уже есть незакрытый пункт",
    );
  }
  if (input.list.items.length >= constants.dayListMaxItems) {
    throw new DomainError("list_full", "Список дня заполнен");
  }
  const item: TaskListItem = {
    id: input.itemId,
    projectId: input.list.projectId,
    listId: input.list.id,
    taskId: input.task.id,
    position: input.list.items.length,
    isDone: false,
    carriedFromListId: null,
  };
  return {
    list: { ...input.list, items: [...input.list.items, item] },
    item,
  };
}

function appearancesOf(
  lists: readonly TaskList[],
  taskId: string,
): number {
  return lists.reduce(
    (count, list) =>
      count + list.items.filter((item) => item.taskId === taskId).length,
    0,
  );
}

function withClosedItem(list: TaskList, itemId: string): TaskList {
  return {
    ...list,
    items: list.items.map((item) =>
      item.id === itemId ? { ...item, isDone: true } : item,
    ),
  };
}

/**
 * A-14 / INV-14: незакрытые пункты других дат переезжают в новый список.
 * Старый пункт закрывается, чтобы не было двух незакрытых; повтор на ту же
 * дату (task_id + list_date) не создаёт второй пункт.
 */
export function carryOverOpenItems(input: {
  lists: readonly TaskList[];
  targetList: TaskList;
  itemIdFor: (taskId: string) => string;
}): {
  lists: TaskList[];
  targetList: TaskList;
  events: TaskCarriedOverEvent[];
} {
  const byId = new Map<string, TaskList>();
  for (const list of input.lists) {
    byId.set(list.id, list);
  }
  byId.set(input.targetList.id, input.targetList);

  let target = byId.get(input.targetList.id) ?? input.targetList;
  const events: TaskCarriedOverEvent[] = [];

  const sources = [...byId.values()].filter(
    (list) => list.id !== target.id && list.projectId === target.projectId,
  );
  for (const source of sources) {
    for (const item of source.items) {
      if (item.isDone) {
        continue;
      }
      if (target.items.some((entry) => entry.taskId === item.taskId)) {
        continue;
      }
      const snapshot = [...byId.values()];
      const carried: TaskListItem = {
        id: input.itemIdFor(item.taskId),
        projectId: target.projectId,
        listId: target.id,
        taskId: item.taskId,
        position: target.items.length,
        isDone: false,
        carriedFromListId: source.id,
      };
      target = { ...target, items: [...target.items, carried] };
      byId.set(target.id, target);
      const currentSource = byId.get(source.id) ?? source;
      byId.set(source.id, withClosedItem(currentSource, item.id));
      events.push({
        type: EVENT_TYPES.TASK_CARRIED_OVER,
        actor: { id: "system", role: "system" },
        subject: { entity: "Task", id: item.taskId },
        payload: {
          task_id: item.taskId,
          from_list_id: source.id,
          to_list_id: target.id,
          day_number: appearancesOf(snapshot, item.taskId) + 1,
        },
        idempotencyKey: `${item.taskId}:${target.listDate}`,
      });
    }
  }

  return {
    lists: [...byId.values()],
    targetList: target,
    events,
  };
}

export function checkDayListItem(input: {
  list: TaskList;
  task: Task;
  blockers: readonly Blocker[];
  itemId: string;
  actor: ProjectActor;
  idempotencyKey: string;
}): {
  list: TaskList;
  task: Task;
  blockers: Blocker[];
  events: Array<TaskCheckedEvent | BlockerResolvedEvent>;
} {
  const item = input.list.items.find((entry) => entry.id === input.itemId);
  if (item === undefined || item.taskId !== input.task.id || item.isDone) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  const checked = checkTask({
    task: input.task,
    blockers: input.blockers,
    listItemId: item.id,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
  });
  const items = input.list.items.map((entry) =>
    entry.id === item.id ? { ...entry, isDone: true } : entry,
  );
  return {
    list: { ...input.list, items },
    task: checked.task,
    blockers: checked.blockers,
    events: checked.events,
  };
}

/** Закрыть пункт без галочки: отложить / отменить (INV-14). */
export function closeOpenItem(list: TaskList, itemId: string): TaskList {
  const item = list.items.find((entry) => entry.id === itemId);
  if (item === undefined || item.isDone) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  return {
    ...list,
    items: list.items.map((entry) =>
      entry.id === itemId ? { ...entry, isDone: true } : entry,
    ),
  };
}
