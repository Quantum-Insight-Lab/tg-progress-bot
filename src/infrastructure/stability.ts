import { sql, type Kysely } from 'kysely';
import { RECONCILE_INTERVAL } from '../config/constants.ts';
import { scheduledReportKey } from '../domain/projects/deliver-report.ts';
import { previousCalendarDate } from '../domain/progress/divergence.ts';
import {
  mirrorIsStale,
  noDataShareWarrantsAlert,
  rateBelowFloor,
  recordAlert,
  recordInvariantViolation,
  recordReportDeliveryFailure,
  recordSchedulerMiss,
  recordTelegramFailure,
  reportDeliveryFailedKey,
  telegramFailureKind,
  type MissedSlot,
  type ReportDeliveryTarget,
} from '../domain/shared/observe.ts';
import { projectCalendarDate } from '../domain/shared/project-time.ts';
import { EVENT_TYPES } from '../events/index.ts';
import { stabilityDashboard, type StabilityLine } from '../projections/stability.ts';
import type { Logger } from '../domain/shared/logger.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';
import { loadProjectShareRatio } from './repository-share.ts';

const MILLISECONDS_PER_MINUTE = 60_000;

const TELEGRAM_RATE_LIMIT = 429;
const METRIC_VIOLATION = 'M-11';
const METRIC_MISSED = 'M-18';
const METRIC_DELIVERY = 'M-19';
const METRIC_LAG = 'M-8';
const METRIC_RATE = 'M-17';
const METRIC_NO_DATA = 'M-10';

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function utcWeek(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekday = date.getUTCDay();
  const shift = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + shift);
  return date.toISOString().slice(0, 10);
}

function errorCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { error_code?: unknown; error?: { error_code?: unknown } };
  if (typeof record.error_code === 'number' && Number.isInteger(record.error_code)) return record.error_code;
  const nested = record.error?.error_code;
  if (typeof nested === 'number' && Number.isInteger(nested)) return nested;
  return null;
}

/** A-40. Ошибка Bot API не подменяет ответ человеку: вызывающий пробрасывает её дальше. */
export async function observeTelegramFailure(
  db: Kysely<Database>,
  logger: Logger,
  occurredAt: Date,
  input: { method: string; error: unknown; chatId: string | null; messageId: number | null; scope: string },
): Promise<void> {
  const errorCode = errorCodeOf(input.error);
  if (errorCode === null) return;
  await recordTelegramFailure(createEventJournal(db, logger), occurredAt, {
    method: input.method,
    kind: telegramFailureKind({ rateLimited: errorCode === TELEGRAM_RATE_LIMIT, edit: input.method.startsWith('edit') }),
    errorCode,
    chatId: input.chatId,
    messageId: input.messageId,
    scope: input.scope,
  });
}

/** A-43. */
export async function observeReportDeliveryFailure(
  db: Kysely<Database>,
  logger: Logger,
  occurredAt: Date,
  input: { target: ReportDeliveryTarget; chatId: string; topicId: number | null; error: unknown; date: string },
): Promise<void> {
  await recordReportDeliveryFailure(createEventJournal(db, logger), occurredAt, {
    target: input.target,
    chatId: input.chatId,
    topicId: input.topicId,
    errorCode: errorCodeOf(input.error),
    date: input.date,
  });
}

async function seen(db: Kysely<Database>, key: string): Promise<boolean> {
  const found = await sql<{ id: string }>`SELECT id FROM events WHERE idempotency_key = ${key}`.execute(db);
  return found.rows.length > 0;
}

/** A-42. Только вчерашние закрытые сутки снимка и отчёта по расписанию. */
export async function noticeMissedSlots(db: Kysely<Database>, logger: Logger, now: Date): Promise<void> {
  const projects = await sql<{ id: string; timezone: string; created_at: Date | string }>`
    SELECT id::text AS id, timezone, created_at FROM projects ORDER BY id
  `.execute(db);
  for (const project of projects.rows) {
    const today = projectCalendarDate(now, project.timezone);
    const missed = previousCalendarDate(today);
    const created = projectCalendarDate(new Date(project.created_at), project.timezone);
    if (created > missed) continue;
    const key = `${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}+${project.id}+${missed}`;
    if (await seen(db, key)) continue;
    await recordSchedulerMiss(createEventJournal(db, logger), now, { action: 'A-32', subjectId: project.id, date: missed });
  }
  const chats = await sql<{ id: string; timezone: string; daily_cron: string | null; reports_topic_id: string | number | null }>`
    SELECT id::text AS id, timezone, daily_cron, reports_topic_id FROM chats ORDER BY id
  `.execute(db);
  for (const chat of chats.rows) {
    if (chat.daily_cron === null || chat.daily_cron.trim().length === 0) continue;
    if (chat.reports_topic_id === null) continue;
    const today = projectCalendarDate(now, chat.timezone);
    const missed = previousCalendarDate(today);
    const scheduled = await sql<{ created_at: Date | string }>`
      SELECT created_at FROM events
      WHERE event_type = ${EVENT_TYPES.CHAT_SCHEDULE_SET} AND subject_id = ${chat.id}
      ORDER BY created_at
      LIMIT 1
    `.execute(db);
    const first = scheduled.rows[0];
    if (first === undefined) continue;
    if (projectCalendarDate(new Date(first.created_at), chat.timezone) > missed) continue;
    if (await seen(db, scheduledReportKey(chat.id, missed))) continue;
    if (await seen(db, reportDeliveryFailedKey(chat.id, missed, 'group'))) continue;
    await recordSchedulerMiss(createEventJournal(db, logger), now, { action: 'A-33' as MissedSlot, subjectId: chat.id, date: missed });
  }
}

/** A-44. DONE без подтверждения, DONE с открытым блокером, не один корень. */
export async function noticeInvariantViolations(db: Kysely<Database>, logger: Logger, now: Date): Promise<void> {
  const date = utcDay(now);
  const journal = () => createEventJournal(db, logger);
  const unconfirmed = await sql<{ id: string }>`
    SELECT t.id::text AS id
    FROM tasks AS t
    WHERE t.status = 'DONE'
      AND NOT EXISTS (
        SELECT 1 FROM events AS e
        WHERE e.event_type = ${EVENT_TYPES.TASK_CONFIRMED}
          AND e.payload->>'task_id' = t.id::text
      )
  `.execute(db);
  for (const row of unconfirmed.rows) {
    await recordInvariantViolation(journal(), now, {
      invariantId: 'INV-06',
      subjectEntity: 'Task',
      subjectId: row.id,
      date,
    });
  }
  const blocked = await sql<{ id: string }>`
    SELECT t.id::text AS id
    FROM tasks AS t
    JOIN blockers AS b ON b.task_id = t.id
    WHERE t.status = 'DONE' AND b.resolved_at IS NULL
  `.execute(db);
  for (const row of blocked.rows) {
    await recordInvariantViolation(journal(), now, {
      invariantId: 'INV-11',
      subjectEntity: 'Task',
      subjectId: row.id,
      date,
    });
  }
  const roots = await sql<{ users: number; rooted: number }>`
    SELECT CAST(count(*) AS int) AS users, CAST(count(*) FILTER (WHERE is_root) AS int) AS rooted FROM users
  `.execute(db);
  const census = roots.rows[0];
  if (census !== undefined && census.users > 0 && census.rooted !== 1) {
    await recordInvariantViolation(journal(), now, {
      invariantId: 'INV-17',
      subjectEntity: 'User',
      subjectId: 'root',
      date,
    });
  }
}

interface RootRow {
  id: string;
  telegram_user_id: string;
}

async function rootOf(db: Kysely<Database>): Promise<RootRow | null> {
  const found = await sql<RootRow>`
    SELECT id::text AS id, telegram_user_id::text AS telegram_user_id FROM users WHERE is_root
  `.execute(db);
  return found.rows[0] ?? null;
}

async function alert(
  db: Kysely<Database>,
  logger: Logger,
  now: Date,
  root: RootRow,
  line: StabilityLine,
  subjectId: string,
  period: 'day' | 'week',
  periodStart: string,
  send: (telegramUserId: string, text: string) => Promise<void>,
): Promise<void> {
  const applied = await recordAlert(createEventJournal(db, logger), now, {
    metric: line.metric,
    subjectId,
    recipientId: root.id,
    period,
    periodStart,
    text: line.text,
  });
  if (!applied) return;
  const body = stabilityDashboard([line]);
  await send(root.telegram_user_id, body);
}

/**
 * A-45. Сразу: нарушение, пропуск слота, сбой отчёта, отставание зеркала.
 * Сутки UTC: остаток лимита. Неделя UTC: канвасы без доли.
 */
export async function notifyRoot(
  db: Kysely<Database>,
  logger: Logger,
  now: Date,
  send: (telegramUserId: string, text: string) => Promise<void>,
): Promise<void> {
  const root = await rootOf(db);
  if (root === null) return;
  const day = utcDay(now);
  const violations = await sql<{ invariant_id: string; subject_id: string }>`
    SELECT payload->>'invariant_id' AS invariant_id, payload->>'subject_id' AS subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.INVARIANT_VIOLATED}
      AND payload->>'date' = ${day}
  `.execute(db);
  for (const row of violations.rows) {
    if (row.invariant_id === null || row.subject_id === null) continue;
    await alert(
      db,
      logger,
      now,
      root,
      { metric: METRIC_VIOLATION, text: `${row.invariant_id} #${row.subject_id}` },
      `${row.invariant_id}:${row.subject_id}`,
      'day',
      day,
      send,
    );
  }
  const missed = await sql<{ action: string; subject_id: string }>`
    SELECT payload->>'action' AS action, payload->>'subject_id' AS subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.SCHEDULER_MISSED}
      AND created_at >= ${`${day}T00:00:00.000Z`}::timestamptz
      AND created_at < ${`${day}T00:00:00.000Z`}::timestamptz + interval '1 day'
  `.execute(db);
  for (const row of missed.rows) {
    if (row.subject_id === null) continue;
    await alert(db, logger, now, root, { metric: METRIC_MISSED, text: `${row.action ?? ''} #${row.subject_id}` }, row.subject_id, 'day', day, send);
  }
  const failed = await sql<{ target: string; chat_id: string }>`
    SELECT payload->>'target' AS target, payload->>'chat_id' AS chat_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.REPORT_DELIVERY_FAILED}
      AND created_at >= ${`${day}T00:00:00.000Z`}::timestamptz
      AND created_at < ${`${day}T00:00:00.000Z`}::timestamptz + interval '1 day'
  `.execute(db);
  for (const row of failed.rows) {
    if (row.chat_id === null) continue;
    await alert(db, logger, now, root, { metric: METRIC_DELIVERY, text: `${row.target ?? ''} #${row.chat_id}` }, row.chat_id, 'day', day, send);
  }
  const mirrors = await sql<{ id: string; freshest: Date | string | null }>`
    SELECT r.id::text AS id,
      GREATEST(
        (SELECT max(updated_at) FROM issues WHERE repository_id = r.id),
        (SELECT max(updated_at) FROM pull_requests WHERE repository_id = r.id),
        (SELECT max(created_at) FROM commits WHERE repository_id = r.id)
      ) AS freshest
    FROM repositories AS r
  `.execute(db);
  for (const row of mirrors.rows) {
    if (row.freshest === null) continue;
    const elapsed = now.getTime() - new Date(row.freshest).getTime();
    if (!mirrorIsStale(elapsed, RECONCILE_INTERVAL * MILLISECONDS_PER_MINUTE)) continue;
    await alert(db, logger, now, root, { metric: METRIC_LAG, text: `#${row.id}` }, row.id, 'day', day, send);
  }
  const rate = await sql<{ remaining_percent: number | string }>`
    SELECT payload->>'remaining_percent' AS remaining_percent
    FROM events
    WHERE event_type = ${EVENT_TYPES.GITHUB_RATE_OBSERVED}
    ORDER BY created_at DESC
    LIMIT 1
  `.execute(db);
  const sample = rate.rows[0];
  if (sample !== undefined && rateBelowFloor(Number(sample.remaining_percent))) {
    await alert(db, logger, now, root, { metric: METRIC_RATE, text: String(sample.remaining_percent) }, 'app', 'day', day, send);
  }
  const canvases = await sql<{ project_id: string }>`SELECT project_id::text AS project_id FROM canvases`.execute(db);
  let withoutData = 0;
  const known = new Map<string, boolean>();
  for (const canvas of canvases.rows) {
    let missing = known.get(canvas.project_id);
    if (missing === undefined) {
      missing = (await loadProjectShareRatio(db, canvas.project_id)) === null;
      known.set(canvas.project_id, missing);
    }
    if (missing) withoutData += 1;
  }
  if (noDataShareWarrantsAlert(canvases.rows.length, withoutData)) {
    await alert(db, logger, now, root, { metric: METRIC_NO_DATA, text: String(withoutData) }, 'canvases', 'week', utcWeek(now), send);
  }
}

/** Ход A-42, A-44 и A-45 одним вызовом из слотов. */
export function stabilityActions(db: Kysely<Database>, logger: Logger, send: (telegramUserId: string, text: string) => Promise<void>): {
  missed(now: Date): Promise<void>;
  violations(now: Date): Promise<void>;
  alerts(now: Date): Promise<void>;
} {
  return {
    missed: (now) => noticeMissedSlots(db, logger, now),
    violations: (now) => noticeInvariantViolations(db, logger, now),
    alerts: (now) => notifyRoot(db, logger, now, send),
  };
}
