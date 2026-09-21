import { constants } from "../../config/index.js";
import { DomainError } from "../shared/errors.js";
import { checkTask, type TaskCheckedEvent } from "./commands.js";
import type { BlockerResolvedEvent } from "./blockers.js";
import type { Blocker, ProjectActor, Task, TaskList, TaskListItem } from "./types.js";

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
