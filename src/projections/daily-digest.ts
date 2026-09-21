import { EVENT_TYPES } from "../events/generated/event-types.js";
import { clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import { blockersBoard } from "./blockers-board.js";
import { occurredIso, numberField, stringField } from "./payload.js";
import { planQueue } from "./plan-queue.js";
import type { PlanItem } from "./types.js";

export type DigestTask = {
  id: string;
  projectId: string;
  title: string;
  status: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
  priority: "high" | "normal" | "low";
  lastChangeAt: string | null;
};

export type DailyProjectSlice = {
  projectId: string;
  name: string;
  timezone: string;
  today: string;
  tasks: DigestTask[];
  previousProgress: number | null;
  todayClosed: number;
  todayStarted: number;
  todayBlocked: number;
  changed: string[];
  plan: PlanItem[];
  risk: string | null;
};

function daysWord(days: number): string {
  const mod10 = days % 10;
  const mod100 = days % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "день";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "дня";
  }
  return "дней";
}

function riskOf(
  declared: { reason: string }[],
  stale: {
    pullRequestNumber: number | null;
    idleDays: number | null;
    ciRed: boolean;
  }[],
): string | null {
  const named = declared[0]?.reason;
  if (named !== undefined) {
    return named;
  }
  const fact = stale[0];
  if (fact === undefined) {
    return null;
  }
  const bits: string[] = [];
  if (fact.pullRequestNumber !== null) {
    let pr = `PR #${String(fact.pullRequestNumber)}`;
    if (fact.idleDays !== null) {
      pr += ` без движения ${String(fact.idleDays)} ${daysWord(fact.idleDays)}`;
    }
    bits.push(pr);
  }
  if (fact.ciRed) {
    bits.push("CI красный");
  }
  return bits.length === 0 ? null : bits.join(", ");
}

export async function dailyDigest(
  projectIds: readonly string[],
): Promise<DailyProjectSlice[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "timezone"])
    .where("id", "in", [...projectIds])
    .execute();
  const taskRows = await db
    .selectFrom("tasks")
    .select(["id", "project_id", "title", "status", "priority", "issue_id"])
    .where("project_id", "in", [...projectIds])
    .execute();
  const issues = await db
    .selectFrom("issues")
    .select(["id", "project_id"])
    .where("project_id", "in", [...projectIds])
    .execute();
  const snapshots = await db
    .selectFrom("progress_snapshots")
    .select(["project_id", "progress", "snapshot_date"])
    .where("project_id", "in", [...projectIds])
    .execute();
  const events = await db
    .selectFrom("events")
    .select(["event_type", "occurred_at", "payload"])
    .where("event_type", "in", [
      EVENT_TYPES.TASK_CREATED,
      EVENT_TYPES.TASK_CONFIRMED,
      EVENT_TYPES.BLOCKER_DETECTED,
      EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED,
    ])
    .execute();
  const plans = await planQueue(projectIds);
  const boards = await blockersBoard(projectIds);
  const projectOfIssue = new Map(issues.map((issue) => [issue.id, issue.project_id]));
  const taskById = new Map(taskRows.map((task) => [task.id, task]));
  const lastChange = new Map<string, string>();
  for (const event of events) {
    const taskId = stringField(event.payload, "task_id");
    const iso = occurredIso(event.occurred_at);
    if (taskId === undefined || iso === null) {
      continue;
    }
    const previous = lastChange.get(taskId);
    if (previous === undefined || iso > previous) {
      lastChange.set(taskId, iso);
    }
  }
  return projects.map((project) => {
    const today = clock.calendarDate(project.timezone);
    const previous = snapshots
      .filter(
        (row) => row.project_id === project.id && row.snapshot_date < today,
      )
      .sort((left, right) => right.snapshot_date.localeCompare(left.snapshot_date))[0];
    let todayClosed = 0;
    let todayStarted = 0;
    let todayBlocked = 0;
    const changed: string[] = [];
    for (const event of events) {
      const iso = occurredIso(event.occurred_at);
      if (iso === null) {
        continue;
      }
      if (clock.calendarDateAt(iso, project.timezone) !== today) {
        continue;
      }
      if (event.event_type === EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED) {
        const issueId = stringField(event.payload, "issue_id");
        const pr = numberField(event.payload, "pull_request_number");
        if (
          issueId !== undefined &&
          pr !== undefined &&
          projectOfIssue.get(issueId) === project.id
        ) {
          changed.push(`PR #${String(pr)}`);
        }
        continue;
      }
      const taskId = stringField(event.payload, "task_id");
      const task = taskId === undefined ? undefined : taskById.get(taskId);
      if (task === undefined || task.project_id !== project.id) {
        continue;
      }
      if (event.event_type === EVENT_TYPES.TASK_CREATED) {
        todayStarted += 1;
        changed.push(task.title);
      }
      if (event.event_type === EVENT_TYPES.TASK_CONFIRMED) {
        todayClosed += 1;
        changed.push(task.title);
      }
      if (event.event_type === EVENT_TYPES.BLOCKER_DETECTED) {
        todayBlocked += 1;
      }
    }
    const board = boards.find((card) => card.projectId === project.id);
    return {
      projectId: project.id,
      name: project.name,
      timezone: project.timezone,
      today,
      tasks: taskRows
        .filter((task) => task.project_id === project.id)
        .map((task) => ({
          id: task.id,
          projectId: task.project_id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          lastChangeAt: lastChange.get(task.id) ?? null,
        })),
      previousProgress: previous?.progress ?? null,
      todayClosed,
      todayStarted,
      todayBlocked,
      changed,
      plan: plans.find((card) => card.projectId === project.id)?.items ?? [],
      risk: riskOf(board?.declared ?? [], board?.stale ?? []),
    };
  });
}
