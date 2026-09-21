import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Clock } from "../infrastructure/clock.js";
import {
  addTaskToTodayList,
  carryOverOpenItems,
  checkDayListItem,
  createTask,
  openDayList,
  pickIssueFromMirror,
  requireIssuesInMirror,
  setListMessageId,
  type Blocker,
  type IssueRef,
  type MemberRef,
  type Task,
  type TaskList,
  type TaskListItem,
} from "../domain/tasks/index.js";
import {
  requireMember,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";
import { DomainError } from "../domain/shared/errors.js";
import { dayNumberOf } from "../projections/day-number.js";
import {
  CHECK_CALLBACK_PREFIX,
  CONFIRM_QUESTION,
  ISSUE_CALLBACK_PREFIX,
  ISSUE_PICK_PROMPT,
  MENU_CALLBACK_PREFIX,
  confirmKeyboard,
  issuePickerKeyboard,
} from "./callbacks.js";

export { CHECK_CALLBACK_PREFIX, MENU_CALLBACK_PREFIX } from "./callbacks.js";

export type ProjectIssue = IssueRef & {
  number: number;
  title: string;
};

export type PendingTaskDraft = {
  projectId: string;
  userId: string;
  title: string;
};

export type PendingBlockerAsk = {
  projectId: string;
  taskId: string;
  blockerId: string;
};

export type DayListStore = {
  clock: Clock;
  timeZoneOf: (projectId: string) => string | undefined;
  issuesOf: (projectId: string) => readonly ProjectIssue[];
  pendingOf: (userId: string) => PendingTaskDraft | undefined;
  savePendingTask: (draft: PendingTaskDraft) => void;
  clearPendingTask: (userId: string) => void;
  listsOf: (projectId: string) => TaskList[];
  saveList: (list: TaskList) => void;
  taskOf: (taskId: string) => { task: Task; blockers: Blocker[] } | undefined;
  saveTask: (task: Task, blockers: Blocker[]) => void;
  rosterOf: (projectId: string) => readonly MemberRef[];
  leadsOf: (projectId: string) => readonly { userId: string }[];
  telegramIdOf: (userId: string) => string | undefined;
  projectIdOfItem: (itemId: string) => string | undefined;
  pendingAskOf: (userId: string) => PendingBlockerAsk | undefined;
  savePendingAsk: (userId: string, ask: PendingBlockerAsk) => void;
  clearPendingAsk: (userId: string) => void;
  lastAskedOn: (taskId: string) => string | null;
  markAsked: (taskId: string, onDate: string) => void;
  projectIdOfBlocker: (blockerId: string) => string | undefined;
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

function lineOf(
  item: TaskListItem,
  title: string,
  lists: readonly TaskList[],
): string {
  const mark = item.isDone ? "✅" : "☐";
  const day = dayNumberOf(
    item,
    lists.flatMap((list) => list.items),
  );
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
    if (task?.status === "PLANNED" || task?.status === "CANCELLED") {
      continue;
    }
    const title = task?.title ?? item.taskId;
    lines.push(lineOf(item, title, lists));
    if (!item.isDone) {
      keyboard
        .text("✓", `${CHECK_CALLBACK_PREFIX}${item.id}`)
        .text("⋯", `${MENU_CALLBACK_PREFIX}${item.id}`)
        .row();
    }
  }
  return { text: lines.join("\n"), keyboard };
}

function parseTaskCommand(text: string | undefined): { title: string } | undefined {
  if (text === undefined) {
    return undefined;
  }
  const title = text.replace(/^\/task(?:@\S+)?/u, "").trim();
  if (title.length === 0) {
    return undefined;
  }
  return { title };
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

export async function publishList(ctx: Context, store: DayListStore, list: TaskList): Promise<void> {
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
    await ctx.reply("Нужна формулировка");
    return;
  }
  const mirrored = store.issuesOf(access.projectId);
  requireIssuesInMirror(mirrored, access.projectId);
  store.savePendingTask({
    projectId: access.projectId,
    userId: member.userId,
    title: parsed.title,
  });
  const markup = issuePickerKeyboard(mirrored);
  const threadId = ctx.message?.message_thread_id;
  if (threadId === undefined) {
    await ctx.reply(ISSUE_PICK_PROMPT, { reply_markup: markup });
    return;
  }
  await ctx.reply(ISSUE_PICK_PROMPT, {
    reply_markup: markup,
    message_thread_id: threadId,
  });
}

export async function onPickIssueCallback(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (data === undefined || !data.startsWith(ISSUE_CALLBACK_PREFIX)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const issueId = data.slice(ISSUE_CALLBACK_PREFIX.length);
  const draft = store.pendingOf(member.userId);
  if (draft === undefined || draft.projectId !== access.projectId) {
    throw new DomainError("invalid_transition", "Нужна формулировка");
  }
  const issue = pickIssueFromMirror(
    store.issuesOf(access.projectId),
    access.projectId,
    issueId,
  );
  const list = ensureTodayList(access, member, store);
  const lists = store.listsOf(access.projectId);
  const created = createTask({
    id: store.newId(),
    projectId: access.projectId,
    issueId: issue.id,
    assigneeId: member.userId,
    title: draft.title,
    createdByUserId: member.userId,
    target: "today",
    issue,
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
  store.clearPendingTask(member.userId);
  await publishList(ctx, store, added.list);
  await ctx.answerCallbackQuery();
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
  await askLeadToConfirm(ctx, store, access.projectId, item.id);
  await ctx.answerCallbackQuery();
}

async function askLeadToConfirm(
  ctx: Context,
  store: DayListStore,
  projectId: string,
  itemId: string,
): Promise<void> {
  const keyboard = confirmKeyboard(itemId);
  for (const lead of store.leadsOf(projectId)) {
    const telegramId = store.telegramIdOf(lead.userId);
    if (telegramId === undefined) {
      continue;
    }
    await ctx.api.sendMessage(Number(telegramId), CONFIRM_QUESTION, {
      reply_markup: keyboard,
    });
  }
}
