import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Clock } from "../infrastructure/clock.js";
import {
  addTaskToTodayList,
  carryOverOpenItems,
  checkDayListItem,
  createTask,
  openDayList,
  setListMessageId,
  type Blocker,
  type IssueRef,
  type Task,
  type TaskList,
  type TaskListItem,
} from "../domain/tasks/index.js";
import {
  requireMember,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";

export const CHECK_CALLBACK_PREFIX = "check:";

export type DayListStore = {
  clock: Clock;
  timeZoneOf: (projectId: string) => string | undefined;
  findIssue: (projectId: string, issueId: string) => IssueRef | undefined;
  listsOf: (projectId: string) => TaskList[];
  saveList: (list: TaskList) => void;
  taskOf: (taskId: string) => { task: Task; blockers: Blocker[] } | undefined;
  saveTask: (task: Task, blockers: Blocker[]) => void;
  newId: () => string;
};

function headingOf(listDate: string): string {
  const parts = listDate.split("-");
  const month = parts[1];
  const day = parts[2];
  if (month === undefined || day === undefined) {
    return listDate;
  }
  return `${day}.${month}`;
}

function dayNumberOf(
  item: TaskListItem,
  lists: readonly TaskList[],
): number {
  let day = 1;
  let fromId = item.carriedFromListId;
  while (fromId !== null) {
    day += 1;
    const previous = lists
      .find((list) => list.id === fromId)
      ?.items.find((entry) => entry.taskId === item.taskId);
    fromId = previous?.carriedFromListId ?? null;
  }
  return day;
}

function lineOf(
  item: TaskListItem,
  title: string,
  lists: readonly TaskList[],
): string {
  const mark = item.isDone ? "✅" : "☐";
  const day = dayNumberOf(item, lists);
  if (item.carriedFromListId === null || day <= 1) {
    return `${mark} ${title}`;
  }
  return `${mark} ${title} · день ${String(day)}`;
}

export function renderDayList(
  list: TaskList,
  tasks: ReadonlyMap<string, Task>,
  lists: readonly TaskList[] = [list],
): { text: string; keyboard: InlineKeyboard } {
  const lines = [headingOf(list.listDate)];
  const keyboard = new InlineKeyboard();
  for (const item of list.items) {
    const task = tasks.get(item.taskId);
    const title = task?.title ?? item.taskId;
    lines.push(lineOf(item, title, lists));
    if (!item.isDone) {
      keyboard.text("✓", `${CHECK_CALLBACK_PREFIX}${item.id}`).row();
    }
  }
  return { text: lines.join("\n"), keyboard };
}

function parseTaskCommand(text: string | undefined): {
  issueId: string;
  title: string;
} | undefined {
  if (text === undefined) {
    return undefined;
  }
  const body = text.replace(/^\/task(?:@\S+)?\s+/u, "").trim();
  const space = body.indexOf(" ");
  if (space <= 0) {
    return undefined;
  }
  const issueId = body.slice(0, space).trim();
  const title = body.slice(space + 1).trim();
  if (issueId.length === 0 || title.length === 0) {
    return undefined;
  }
  return { issueId, title };
}

function openItemsOf(lists: readonly TaskList[]): TaskListItem[] {
  return lists.flatMap((list) => list.items);
}

function tasksMap(store: DayListStore, list: TaskList): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const item of list.items) {
    const found = store.taskOf(item.taskId);
    if (found !== undefined) {
      map.set(item.taskId, found.task);
    }
  }
  return map;
}

function ensureTodayList(
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): TaskList {
  const timeZone = store.timeZoneOf(access.projectId);
  if (timeZone === undefined) {
    requireMember(undefined);
    throw new Error("unreachable");
  }
  const lists = store.listsOf(access.projectId);
  const opened = openDayList({
    lists,
    projectId: access.projectId,
    listDate: store.clock.calendarDate(timeZone),
    newListId: store.newId(),
    topicId: member.topicId,
  });
  if (!opened.created) {
    return opened.list;
  }
  const carried = carryOverOpenItems({
    lists,
    targetList: opened.list,
    itemIdFor: () => store.newId(),
  });
  for (const list of carried.lists) {
    store.saveList(list);
  }
  return carried.targetList;
}

async function publishList(ctx: Context, store: DayListStore, list: TaskList): Promise<void> {
  const rendered = renderDayList(
    list,
    tasksMap(store, list),
    store.listsOf(list.projectId),
  );
  const chatId = ctx.chat?.id;
  if (list.messageId !== null) {
    if (chatId === undefined) {
      return;
    }
    await ctx.api.editMessageText(chatId, list.messageId, rendered.text, {
      reply_markup: rendered.keyboard,
    });
    return;
  }
  const threadId = ctx.message?.message_thread_id;
  const sent =
    threadId === undefined
      ? await ctx.reply(rendered.text, { reply_markup: rendered.keyboard })
      : await ctx.reply(rendered.text, {
          reply_markup: rendered.keyboard,
          message_thread_id: threadId,
        });
  store.saveList(setListMessageId(list, sent.message_id));
}

export async function onTaskCommand(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const parsed = parseTaskCommand(ctx.message?.text);
  if (parsed === undefined) {
    await ctx.reply("Нужны issue и формулировка");
    return;
  }
  const list = ensureTodayList(access, member, store);
  const lists = store.listsOf(access.projectId);
  const created = createTask({
    id: store.newId(),
    projectId: access.projectId,
    issueId: parsed.issueId,
    assigneeId: member.userId,
    title: parsed.title,
    createdByUserId: member.userId,
    target: "today",
    issue: store.findIssue(access.projectId, parsed.issueId),
    assignee: { projectId: access.projectId, userId: member.userId },
    actor: {
      userId: member.userId,
      role: member.role,
    },
    idempotencyKey: store.newId(),
  });
  const added = addTaskToTodayList({
    list,
    task: created.task,
    itemId: store.newId(),
    openItemsForTask: openItemsOf(lists),
  });
  store.saveTask(created.task, []);
  store.saveList(added.list);
  await publishList(ctx, store, added.list);
}

export async function onCheckCallback(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (data === undefined || !data.startsWith(CHECK_CALLBACK_PREFIX)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const itemId = data.slice(CHECK_CALLBACK_PREFIX.length);
  const lists = store.listsOf(access.projectId);
  const list = lists.find((entry) =>
    entry.items.some((item) => item.id === itemId),
  );
  const item = list?.items.find((entry) => entry.id === itemId);
  if (list === undefined || item === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const loaded = store.taskOf(item.taskId);
  if (loaded === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const checked = checkDayListItem({
    list,
    task: loaded.task,
    blockers: loaded.blockers,
    itemId,
    actor: {
      userId: member.userId,
      role: member.role,
      projectId: access.projectId,
    },
    idempotencyKey: `${itemId}:checked`,
  });
  store.saveTask(checked.task, checked.blockers);
  store.saveList(checked.list);
  await publishList(ctx, store, checked.list);
  await ctx.answerCallbackQuery();
}
