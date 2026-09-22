import type { Bot } from "grammy";
import type { Context } from "grammy";
import { githubReconcileIntervalMs } from "../config/index.js";
import { githubSignalsAllowed } from "../domain/github/index.js";
import {
  applyStaleSignals,
  declareBlocker,
  dismissBlocker,
  mayReAsk,
  signalsDue,
  type GithubIdleFacts,
  type ProjectActor,
} from "../domain/tasks/index.js";
import type { ProjectAccess, ProjectMember } from "../domain/projects/index.js";
import { dayNumberOf } from "../projections/day-number.js";
import { commitFact } from "./publish.js";
import {
  BLOCKER_ASK_HINT,
  DISMISS_BLOCKER_PREFIX,
  noBlockerKeyboard,
} from "./callbacks.js";
import type { DayListStore } from "./day-list.js";

function actorOf(access: ProjectAccess, member: ProjectMember): ProjectActor {
  return {
    userId: member.userId,
    role: member.role,
    projectId: access.projectId,
  };
}

export function blockerAskText(title: string, dayNumber: number): string {
  return `${title} не двигается ${String(dayNumber)}-й день, ${BLOCKER_ASK_HINT}`;
}

export async function scanStaleTasks(
  bot: Bot,
  store: DayListStore,
  input: {
    projectId: string;
    githubLagMs: number | null;
    githubFactsByTaskId?: ReadonlyMap<string, GithubIdleFacts>;
  },
): Promise<void> {
  const timeZone = store.timeZoneOf(input.projectId);
  if (timeZone === undefined) {
    return;
  }
  const today = store.clock.calendarDate(timeZone);
  const lists = store.listsOf(input.projectId);
  const todayList = lists.find((list) => list.listDate === today);
  if (todayList === undefined) {
    return;
  }
  const chain = lists.flatMap((list) => list.items);
  const githubAvailable = githubSignalsAllowed(
    input.githubLagMs,
    githubReconcileIntervalMs(),
  );
  const now = store.clock.now(timeZone);
  for (const item of todayList.items) {
    if (item.isDone) {
      continue;
    }
    const loaded = store.taskOf(item.taskId);
    if (loaded === undefined) {
      continue;
    }
    if (
      loaded.task.status !== "IN_PROGRESS" &&
      loaded.task.status !== "BLOCKED"
    ) {
      continue;
    }
    const daysWithoutCheck = dayNumberOf(item, chain);
    const lastAsked = store.lastAskedOn(item.taskId);
    const daysSinceLastAsk =
      lastAsked === null ? null : store.clock.daysBetween(lastAsked, today);
    const due = signalsDue({
      daysWithoutCheck,
      githubAvailable,
      github: input.githubFactsByTaskId?.get(item.taskId) ?? null,
    });
    const applied = applyStaleSignals({
      task: loaded.task,
      blockers: loaded.blockers,
      signals: due,
      blockerIdFor: (signal) => store.newId() + signal,
      detectedAt: now.iso,
      detectedOnDate: today,
    });
    store.saveTask(applied.task, applied.blockers);
    if (applied.task.status !== "BLOCKED" || !mayReAsk(daysSinceLastAsk)) {
      continue;
    }
    const active = applied.blockers.find(
      (blocker) => blocker.active && blocker.taskId === applied.task.id,
    );
    if (active === undefined) {
      continue;
    }
    const telegramId = store.telegramIdOf(applied.task.assigneeId);
    if (telegramId === undefined) {
      continue;
    }
    await bot.api.sendMessage(
      telegramId,
      blockerAskText(applied.task.title, daysWithoutCheck),
      { reply_markup: noBlockerKeyboard(active.id) },
    );
    store.markAsked(applied.task.id, today);
    store.savePendingAsk(applied.task.assigneeId, {
      projectId: input.projectId,
      taskId: applied.task.id,
      blockerId: active.id,
    });
  }
}

export async function onDismissBlockerCallback(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const blockerId =
    data !== undefined && data.startsWith(DISMISS_BLOCKER_PREFIX)
      ? data.slice(DISMISS_BLOCKER_PREFIX.length)
      : undefined;
  if (blockerId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const ask = store.pendingAskOf(member.userId);
  const taskId = ask?.blockerId === blockerId ? ask.taskId : undefined;
  const loaded = taskId === undefined ? undefined : store.taskOf(taskId);
  if (loaded === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const dismissed = dismissBlocker({
    task: loaded.task,
    blockers: loaded.blockers,
    blockerId,
    actor: actorOf(access, member),
  });
  if (!(await commitFact(dismissed.event.type, dismissed.event))) {
    await ctx.answerCallbackQuery();
    return;
  }
  store.saveTask(dismissed.task, dismissed.blockers);
  store.clearPendingAsk(member.userId);
  await ctx.answerCallbackQuery();
}

export async function onBlockerReasonMessage(
  ctx: Context,
  access: ProjectAccess,
  member: ProjectMember,
  store: DayListStore,
): Promise<void> {
  const ask = store.pendingAskOf(member.userId);
  const reason = ctx.message?.text?.trim();
  if (ask === undefined || reason === undefined || reason.length === 0) {
    return;
  }
  const loaded = store.taskOf(ask.taskId);
  if (loaded === undefined) {
    return;
  }
  const declared = declareBlocker({
    task: loaded.task,
    blockers: loaded.blockers,
    blockerId: ask.blockerId,
    reason,
    actor: actorOf(access, member),
  });
  if (!(await commitFact(declared.event.type, declared.event))) {
    return;
  }
  store.saveTask(loaded.task, declared.blockers);
  store.clearPendingAsk(member.userId);
}
