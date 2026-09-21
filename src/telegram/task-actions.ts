import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { constants, type Priority } from "../config/index.js";
import {
  cancelTask,
  closeOpenItem,
  confirmTask,
  postponeTask,
  prioritizeTask,
  reassignTask,
  type MemberRef,
  type ProjectActor,
  type TaskList,
} from "../domain/tasks/index.js";
import type { ProjectAccess, ProjectMember } from "../domain/projects/index.js";
import {
  ASSIGN_CALLBACK_PREFIX,
  CANCEL_CALLBACK_PREFIX,
  CONFIRM_CALLBACK_PREFIX,
  MENU_CALLBACK_PREFIX,
  PLAN_CALLBACK_PREFIX,
  PRIO_CALLBACK_PREFIX,
} from "./callbacks.js";
import { publishList, type DayListStore } from "./day-list.js";

const PRIORITIES = Object.keys(constants.priorityWeights) as Priority[];

function actorOf(access: ProjectAccess, member: ProjectMember): ProjectActor {
  return {
    userId: member.userId,
    role: member.role,
    projectId: access.projectId,
  };
}

function findItem(
  lists: readonly TaskList[],
  itemId: string,
): { list: TaskList; item: TaskList["items"][number] } | undefined {
  const list = lists.find((entry) =>
    entry.items.some((item) => item.id === itemId),
  );
  const item = list?.items.find((entry) => entry.id === itemId);
  if (list === undefined || item === undefined) {
    return undefined;
  }
  return { list, item };
}

function isPriority(value: string): value is Priority {
  return PRIORITIES.some((priority) => priority === value);
}

function menuKeyboard(itemId: string, roster: readonly MemberRef[]): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("План", `${PLAN_CALLBACK_PREFIX}${itemId}`)
    .text("high", `${PRIO_CALLBACK_PREFIX}${itemId}:high`)
    .text("normal", `${PRIO_CALLBACK_PREFIX}${itemId}:normal`)
    .text("low", `${PRIO_CALLBACK_PREFIX}${itemId}:low`)
    .text("Отмена", `${CANCEL_CALLBACK_PREFIX}${itemId}`)
    .row();
  roster.forEach((member, index) => {
    keyboard.text(`→ ${member.userId}`, `${ASSIGN_CALLBACK_PREFIX}${itemId}:${String(index)}`);
  });
  return keyboard;
}

export async function onTaskActCallback(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (data === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith(MENU_CALLBACK_PREFIX)) {
    const itemId = data.slice(MENU_CALLBACK_PREFIX.length);
    const found = findItem(store.listsOf(access.projectId), itemId);
    const loaded = found === undefined ? undefined : store.taskOf(found.item.taskId);
    if (found === undefined || loaded === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.reply(loaded.task.title, {
      reply_markup: menuKeyboard(itemId, store.rosterOf(access.projectId)),
    });
    await ctx.answerCallbackQuery();
    return;
  }
  const itemId = itemIdFrom(data);
  if (itemId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const found = findItem(store.listsOf(access.projectId), itemId);
  const loaded = found === undefined ? undefined : store.taskOf(found.item.taskId);
  if (found === undefined || loaded === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const actor = actorOf(access, member);
  if (data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
    const confirmed = confirmTask({
      task: loaded.task,
      blockers: loaded.blockers,
      actor,
    });
    store.saveTask(confirmed.task, loaded.blockers);
    await publishList(ctx, store, found.list);
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith(PLAN_CALLBACK_PREFIX)) {
    const postponed = postponeTask({
      task: loaded.task,
      fromListId: found.list.id,
      actor,
      idempotencyKey: `${loaded.task.id}:${found.list.listDate}:postponed`,
    });
    const closed = found.item.isDone
      ? found.list
      : closeOpenItem(found.list, found.item.id);
    store.saveTask(postponed.task, loaded.blockers);
    store.saveList(closed);
    await publishList(ctx, store, closed);
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith(PRIO_CALLBACK_PREFIX)) {
    const priority = data.slice(PRIO_CALLBACK_PREFIX.length + itemId.length + 1);
    if (!isPriority(priority)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const prioritized = prioritizeTask({
      task: loaded.task,
      priority,
      actor,
      idempotencyKey: `${loaded.task.id}:${priority}`,
    });
    store.saveTask(prioritized.task, loaded.blockers);
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith(CANCEL_CALLBACK_PREFIX)) {
    const cancelled = cancelTask({
      task: loaded.task,
      reason: null,
      actor,
    });
    const closed = found.item.isDone
      ? found.list
      : closeOpenItem(found.list, found.item.id);
    store.saveTask(cancelled.task, loaded.blockers);
    store.saveList(closed);
    await publishList(ctx, store, closed);
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith(ASSIGN_CALLBACK_PREFIX)) {
    const indexRaw = data.slice(ASSIGN_CALLBACK_PREFIX.length + itemId.length + 1);
    const index = Number(indexRaw);
    const roster = store.rosterOf(access.projectId);
    const assignee: MemberRef | undefined = Number.isInteger(index)
      ? roster[index]
      : undefined;
    const reassigned = reassignTask({
      task: loaded.task,
      assigneeId: assignee?.userId ?? "",
      assignee,
      actor,
      idempotencyKey: `${loaded.task.id}:reassign:${assignee?.userId ?? ""}`,
    });
    store.saveTask(reassigned.task, loaded.blockers);
    await ctx.answerCallbackQuery();
  }
}

function itemIdFrom(data: string): string | undefined {
  if (data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
    return data.slice(CONFIRM_CALLBACK_PREFIX.length);
  }
  if (data.startsWith(PLAN_CALLBACK_PREFIX)) {
    return data.slice(PLAN_CALLBACK_PREFIX.length);
  }
  if (data.startsWith(CANCEL_CALLBACK_PREFIX)) {
    return data.slice(CANCEL_CALLBACK_PREFIX.length);
  }
  if (data.startsWith(PRIO_CALLBACK_PREFIX)) {
    const rest = data.slice(PRIO_CALLBACK_PREFIX.length);
    const split = rest.lastIndexOf(":");
    if (split <= 0) {
      return undefined;
    }
    return rest.slice(0, split);
  }
  if (data.startsWith(ASSIGN_CALLBACK_PREFIX)) {
    const rest = data.slice(ASSIGN_CALLBACK_PREFIX.length);
    const split = rest.lastIndexOf(":");
    if (split <= 0) {
      return undefined;
    }
    return rest.slice(0, split);
  }
  return undefined;
}
