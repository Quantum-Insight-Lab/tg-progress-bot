import type { Bot, Context } from "grammy";
import {
  formatProgress,
  progressOfAllProjectsForReport,
  progressOfProject,
  type ProgressTask,
} from "../domain/progress/index.js";
import {
  isDailyCronDue,
  recordReportSent,
} from "../domain/reports/index.js";
import {
  type MemberDirectory,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";
import { weightOf } from "../domain/tasks/index.js";
import { emit, EVENT_TYPES } from "../events/index.js";
import { clock as systemClock, type Clock } from "../infrastructure/clock.js";
import { logger } from "../infrastructure/logger.js";
import {
  dailyDigest,
  reportTargets,
  type DailyProjectSlice,
} from "../projections/index.js";
import {
  projectIdsForScreen,
  type ScreenIdentity,
} from "./screens.js";

function escapeMarkdown(value: string): string {
  return value.replace(/[_*[\]`]/g, "\\$&");
}

function percentLabel(value: number | null): string {
  if (value === null) {
    return formatProgress(null);
  }
  return `${String(Math.round(value * 100))}%`;
}

function arrow(previous: number | null, current: number | null): string {
  const now = percentLabel(current);
  if (previous === null) {
    return now;
  }
  return `${percentLabel(previous)} → ${now}`;
}

function nowTitleOf(tasks: DailyProjectSlice["tasks"]): string | null {
  const active = tasks.filter(
    (task) => task.status !== "DONE" && task.status !== "CANCELLED",
  );
  active.sort((left, right) => {
    if (left.lastChangeAt !== right.lastChangeAt) {
      if (left.lastChangeAt === null) {
        return 1;
      }
      if (right.lastChangeAt === null) {
        return -1;
      }
      return right.lastChangeAt.localeCompare(left.lastChangeAt);
    }
    return weightOf(right.priority) - weightOf(left.priority);
  });
  return active[0]?.title ?? null;
}

function nextTitleOf(slice: DailyProjectSlice): string | null {
  const ordered = [...slice.plan].sort((left, right) => {
    if (left.blockedByOpenIssue !== right.blockedByOpenIssue) {
      return left.blockedByOpenIssue ? 1 : -1;
    }
    return weightOf(right.priority) - weightOf(left.priority);
  });
  return ordered.find((item) => !item.blockedByOpenIssue)?.title ?? null;
}

export function composeDailyReport(
  slices: readonly DailyProjectSlice[],
  includeOverall: boolean,
): string {
  const lines = ["## DAILY DEVELOPMENT REPORT"];
  if (includeOverall && slices.length > 0) {
    const tasks: ProgressTask[] = slices.flatMap((slice) => slice.tasks);
    const current = progressOfAllProjectsForReport(tasks);
    const previous = slices.length === 1 ? (slices[0]?.previousProgress ?? null) : null;
    lines.push(`**Все проекты:** ${arrow(previous, current)}`);
  }
  for (const slice of slices) {
    const current = progressOfProject(slice.projectId, slice.tasks);
    lines.push("");
    lines.push(`### ${escapeMarkdown(slice.name)}`);
    lines.push(`**Прогресс:** ${arrow(slice.previousProgress, current)}`);
    if (slice.todayClosed > 0 || slice.todayStarted > 0 || slice.todayBlocked > 0) {
      lines.push(
        `**За день:** ✅ закрыто ${String(slice.todayClosed)} · 🔨 начато ${String(slice.todayStarted)} · ⚠️ заблокировано ${String(slice.todayBlocked)}`,
      );
    }
    if (slice.changed.length > 0) {
      lines.push(
        `**Что изменилось:** ${escapeMarkdown(slice.changed.join("; "))}`,
      );
    }
    const now = nowTitleOf(slice.tasks);
    if (now !== null) {
      lines.push(`**Сейчас:** ${escapeMarkdown(now)}`);
    }
    if (slice.risk !== null) {
      lines.push(`**Риск:** ${escapeMarkdown(slice.risk)}`);
    }
    const next = nextTitleOf(slice);
    if (next !== null) {
      lines.push(`**Следующий шаг:** ${escapeMarkdown(next)}`);
    }
  }
  return lines.join("\n").trim();
}

export async function onReportCommand(
  ctx: Context,
  access: ProjectAccess,
  _member: ProjectMember,
  directory: MemberDirectory,
  identity: ScreenIdentity,
): Promise<void> {
  const privateChat = ctx.chat?.type === "private";
  const projectIds = privateChat
    ? projectIdsForScreen(access, directory, identity)
    : [access.projectId];
  const slices = await dailyDigest(projectIds);
  const text = composeDailyReport(slices, privateChat);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return;
  }
  const periodDate = slices[0]?.today ?? systemClock.calendarDate("UTC");
  const event = recordReportSent({
    targetId: privateChat ? `dm:${access.userId}` : access.projectId,
    reportType: "daily",
    projectIds,
    destination: privateChat ? "dm" : "group",
    chatId,
    topicId: ctx.message?.message_thread_id ?? null,
    periodDate,
  });
  await emit(EVENT_TYPES.REPORT_SENT, {
    actor: event.actor,
    subject: event.subject,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
  });
  await ctx.reply(text, { parse_mode: "Markdown" });
}

export async function dispatchDueDailyReports(
  bot: Bot,
  time: Clock = systemClock,
): Promise<void> {
  const targets = await reportTargets();
  for (const target of targets) {
    const { hour, minute } = time.hourMinute(target.timezone);
    if (!isDailyCronDue(target.scheduleCron, hour, minute)) {
      continue;
    }
    const slices = await dailyDigest([target.projectId]);
    const text = composeDailyReport(slices, false);
    const chatId = Number.parseInt(target.chatId, 10);
    const topicId =
      target.topicId === null ? null : Number.parseInt(target.topicId, 10);
    const periodDate = slices[0]?.today ?? time.calendarDate(target.timezone);
    const event = recordReportSent({
      targetId: target.id,
      reportType: "daily",
      projectIds: [target.projectId],
      destination: "group",
      chatId,
      topicId,
      periodDate,
    });
    const sent = await emit(EVENT_TYPES.REPORT_SENT, {
      actor: event.actor,
      subject: event.subject,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (!sent.applied) {
      continue;
    }
    await bot.api.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(topicId === null ? {} : { message_thread_id: topicId }),
    });
  }
}

/** Опрос раз в минуту, чтобы поймать минуту C-7 в таймзоне проекта. */
export function dailyReportPollIntervalMs(): number {
  return 60 * 1000;
}

export function startDailyReportLoop(deps: {
  bot: Bot;
  intervalMs?: number;
  run?: () => Promise<unknown>;
}): () => void {
  const intervalMs = deps.intervalMs ?? dailyReportPollIntervalMs();
  const run = deps.run ?? (() => dispatchDueDailyReports(deps.bot));
  const tick = (): void => {
    void run().catch((error: unknown) => {
      logger.error("daily report dispatch failed", { error: String(error) });
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
