import { EVENT_TYPES, type EventType } from "../events/generated/event-types.js";
import { getDb } from "../infrastructure/db.js";
import { isRecord, numberField, occurredIso, stringField } from "./payload.js";

export const PROJECTION_NAMES = [
  "today_list",
  "plan_queue",
  "in_progress_board",
  "done_feed",
  "blockers_board",
  "github_state",
  "project_progress",
  "dynamics_series",
  "daily_digest",
  "weekly_digest",
  "access_list",
] as const;

export type ProjectionName = (typeof PROJECTION_NAMES)[number];

const FEEDS: Record<ProjectionName, readonly EventType[] | "all"> = {
  today_list: [
    EVENT_TYPES.TASK_CREATED,
    EVENT_TYPES.TASK_CHECKED,
    EVENT_TYPES.TASK_CARRIED_OVER,
  ],
  plan_queue: [
    EVENT_TYPES.TASK_CREATED,
    EVENT_TYPES.TASK_POSTPONED,
    EVENT_TYPES.GITHUB_ISSUE_LINKED,
  ],
  in_progress_board: [
    EVENT_TYPES.TASK_CHECKED,
    EVENT_TYPES.BLOCKER_DETECTED,
    EVENT_TYPES.BLOCKER_DECLARED,
    EVENT_TYPES.BLOCKER_DISMISSED,
    EVENT_TYPES.BLOCKER_RESOLVED,
    EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED,
  ],
  done_feed: [EVENT_TYPES.TASK_CONFIRMED],
  blockers_board: [
    EVENT_TYPES.BLOCKER_DETECTED,
    EVENT_TYPES.BLOCKER_DECLARED,
    EVENT_TYPES.BLOCKER_DISMISSED,
    EVENT_TYPES.BLOCKER_RESOLVED,
    EVENT_TYPES.GITHUB_CHECKS_FAILED,
  ],
  github_state: [
    EVENT_TYPES.GITHUB_ISSUE_UPDATED,
    EVENT_TYPES.GITHUB_ISSUE_LINKED,
    EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED,
    EVENT_TYPES.GITHUB_CHECKS_FAILED,
    EVENT_TYPES.GITHUB_MILESTONE_UPDATED,
    EVENT_TYPES.TASK_CREATED,
  ],
  project_progress: [
    EVENT_TYPES.TASK_CREATED,
    EVENT_TYPES.TASK_PRIORITIZED,
    EVENT_TYPES.TASK_REASSIGNED,
    EVENT_TYPES.TASK_POSTPONED,
    EVENT_TYPES.TASK_CHECKED,
    EVENT_TYPES.TASK_UNCHECKED,
    EVENT_TYPES.TASK_CONFIRMED,
    EVENT_TYPES.TASK_CANCELLED,
    EVENT_TYPES.GITHUB_ISSUE_UPDATED,
  ],
  dynamics_series: [EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN],
  daily_digest: "all",
  weekly_digest: "all",
  access_list: [
    EVENT_TYPES.PROJECT_MEMBER_ADDED,
    EVENT_TYPES.PROJECT_MEMBER_REMOVED,
  ],
};

export function isProjectionName(name: string): name is ProjectionName {
  return (PROJECTION_NAMES as readonly string[]).includes(name);
}

function snapshotDateOf(idempotencyKey: string | null): string | null {
  if (idempotencyKey === null) {
    return null;
  }
  const match = /:(\d{4}-\d{2}-\d{2})$/.exec(idempotencyKey);
  return match?.[1] ?? null;
}

function subjectId(subject: unknown): string | null {
  if (!isRecord(subject)) {
    return null;
  }
  const id = subject.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function rebuildDynamics(): Promise<number> {
  const db = getDb();
  const rows = await db
    .selectFrom("events")
    .select(["subject", "payload", "occurred_at", "idempotency_key"])
    .where("event_type", "=", EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN)
    .orderBy("occurred_at", "asc")
    .execute();
  for (const row of rows) {
    const id = subjectId(row.subject);
    const projectId = stringField(row.payload, "project_id");
    const snapshotDate = snapshotDateOf(row.idempotency_key);
    const occurred = occurredIso(row.occurred_at);
    const tasksTotal = numberField(row.payload, "tasks_total");
    const tasksDone = numberField(row.payload, "tasks_done");
    if (
      id === null ||
      projectId === undefined ||
      snapshotDate === null ||
      occurred === null ||
      tasksTotal === undefined ||
      tasksDone === undefined
    ) {
      continue;
    }
    const progress = numberField(row.payload, "progress") ?? null;
    await db
      .insertInto("progress_snapshots")
      .values({
        id,
        project_id: projectId,
        progress,
        tasks_total: tasksTotal,
        tasks_done: tasksDone,
        snapshot_date: snapshotDate,
        created_at: occurred,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          progress,
          tasks_total: tasksTotal,
          tasks_done: tasksDone,
          snapshot_date: snapshotDate,
          created_at: occurred,
        }),
      )
      .execute();
  }
  return rows.length;
}

/** Пересборка read model из журнала. В журнал не пишет (S-5). */
export async function rebuildProjection(
  name: ProjectionName,
): Promise<{ name: ProjectionName; events: number }> {
  if (name === "dynamics_series") {
    return { name, events: await rebuildDynamics() };
  }
  const feed = FEEDS[name];
  const db = getDb();
  const query = db.selectFrom("events").select("event_id");
  const rows =
    feed === "all"
      ? await query.execute()
      : await query.where("event_type", "in", [...feed]).execute();
  return { name, events: rows.length };
}
