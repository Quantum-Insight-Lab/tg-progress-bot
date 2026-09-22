import { EVENT_TYPES } from "../events/generated/event-types.js";
import { getDb } from "../infrastructure/db.js";
import { occurredIso, stringField } from "../projections/payload.js";

const MS_PER_HOUR = 60 * 60 * 1000;

function hoursBetween(fromIso: string, toIso: string): number | null {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return null;
  }
  return (toMs - fromMs) / MS_PER_HOUR;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

type EventRow = {
  event_type: string;
  occurred_at: string;
  payload: unknown;
};

async function loadEvents(types: readonly string[]): Promise<EventRow[]> {
  if (types.length === 0) {
    return [];
  }
  const db = getDb();
  return db
    .selectFrom("events")
    .select(["event_type", "occurred_at", "payload"])
    .where("event_type", "in", [...types])
    .execute();
}

export async function blockerClarityHours(): Promise<number | null> {
  const rows = await loadEvents([
    EVENT_TYPES.BLOCKER_DETECTED,
    EVENT_TYPES.BLOCKER_DECLARED,
    EVENT_TYPES.BLOCKER_DISMISSED,
  ]);
  const detected = new Map<string, string>();
  const answered = new Map<string, string>();
  for (const row of rows) {
    const id = stringField(row.payload, "blocker_id");
    const iso = occurredIso(row.occurred_at);
    if (id === undefined || iso === null) {
      continue;
    }
    if (row.event_type === EVENT_TYPES.BLOCKER_DETECTED) {
      const previous = detected.get(id);
      if (previous === undefined || iso < previous) {
        detected.set(id, iso);
      }
      continue;
    }
    const previous = answered.get(id);
    if (previous === undefined || iso < previous) {
      answered.set(id, iso);
    }
  }
  const hours: number[] = [];
  for (const [id, start] of detected) {
    const end = answered.get(id);
    if (end === undefined) {
      continue;
    }
    const value = hoursBetween(start, end);
    if (value !== null) {
      hours.push(value);
    }
  }
  return mean(hours);
}

export async function confirmationHours(): Promise<number | null> {
  const rows = await loadEvents([
    EVENT_TYPES.TASK_CHECKED,
    EVENT_TYPES.TASK_CONFIRMED,
  ]);
  const checked = new Map<string, string>();
  const confirmed = new Map<string, string>();
  for (const row of rows) {
    const id = stringField(row.payload, "task_id");
    const iso = occurredIso(row.occurred_at);
    if (id === undefined || iso === null) {
      continue;
    }
    if (row.event_type === EVENT_TYPES.TASK_CHECKED) {
      const previous = checked.get(id);
      if (previous === undefined || iso < previous) {
        checked.set(id, iso);
      }
      continue;
    }
    const previous = confirmed.get(id);
    if (previous === undefined || iso < previous) {
      confirmed.set(id, iso);
    }
  }
  const hours: number[] = [];
  for (const [id, start] of checked) {
    const end = confirmed.get(id);
    if (end === undefined) {
      continue;
    }
    const value = hoursBetween(start, end);
    if (value !== null) {
      hours.push(value);
    }
  }
  return mean(hours);
}

export async function blockerAnswerRates(): Promise<{
  answerRate: number | null;
  dismissRate: number | null;
}> {
  const rows = await loadEvents([
    EVENT_TYPES.BLOCKER_DETECTED,
    EVENT_TYPES.BLOCKER_DECLARED,
    EVENT_TYPES.BLOCKER_DISMISSED,
  ]);
  const detected = new Set<string>();
  const declared = new Set<string>();
  const dismissed = new Set<string>();
  for (const row of rows) {
    const id = stringField(row.payload, "blocker_id");
    if (id === undefined) {
      continue;
    }
    if (row.event_type === EVENT_TYPES.BLOCKER_DETECTED) {
      detected.add(id);
    } else if (row.event_type === EVENT_TYPES.BLOCKER_DECLARED) {
      declared.add(id);
    } else {
      dismissed.add(id);
    }
  }
  const answered = new Set([...declared, ...dismissed]);
  const answerRate =
    detected.size === 0 ? null : answered.size / detected.size;
  const resolved = declared.size + dismissed.size;
  const dismissRate = resolved === 0 ? null : dismissed.size / resolved;
  return { answerRate, dismissRate };
}

export async function orphanSignals(): Promise<number> {
  const db = getDb();
  const issues = await db
    .selectFrom("issues")
    .leftJoin("tasks", "tasks.issue_id", "issues.id")
    .select("issues.id as id")
    .where("issues.state", "=", "open")
    .where("tasks.id", "is", null)
    .execute();
  if (issues.length === 0) {
    return 0;
  }
  const issueIds = issues.map((row) => row.id);
  const failing = await db
    .selectFrom("check_runs")
    .innerJoin(
      "issue_pull_requests",
      "issue_pull_requests.id",
      "check_runs.pull_request_id",
    )
    .select("issue_pull_requests.issue_id as issue_id")
    .where("issue_pull_requests.issue_id", "in", issueIds)
    .where("check_runs.conclusion", "in", ["failure", "timed_out", "cancelled"])
    .execute();
  const ids = new Set(
    failing
      .map((row) => row.issue_id)
      .filter((id): id is string => id !== null),
  );
  return ids.size;
}

export async function reportSentExists(idempotencyKey: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom("events")
    .select("event_id")
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return row !== undefined;
}

export async function leadTelegramUserIds(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("project_members")
    .innerJoin("users", "users.id", "project_members.user_id")
    .select("users.telegram_user_id as telegram_user_id")
    .where("project_members.role", "=", "lead")
    .execute();
  return [...new Set(rows.map((row) => row.telegram_user_id))];
}
