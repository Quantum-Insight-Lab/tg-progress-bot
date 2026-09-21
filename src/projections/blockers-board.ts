import { EVENT_TYPES } from "../events/generated/event-types.js";
import { clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import { numberField, occurredIso, stringField } from "./payload.js";
import type { BlockersCard, DeclaredBlockerItem, StaleBlockerItem } from "./types.js";

type TaskAcc = {
  projectId: string;
  title: string;
  issueId: string;
  reason: string | null;
  requiredAction: string | null;
  pullRequestNumber: number | null;
  ciRed: boolean;
  noBranch: boolean;
  noIssueActivity: boolean;
  detectedAt: string | null;
};

function accOf(row: {
  project_id: string;
  title: string;
  issue_id: string;
}): TaskAcc {
  return {
    projectId: row.project_id,
    title: row.title,
    issueId: row.issue_id,
    reason: null,
    requiredAction: null,
    pullRequestNumber: null,
    ciRed: false,
    noBranch: false,
    noIssueActivity: false,
    detectedAt: null,
  };
}

export async function blockersBoard(
  projectIds: readonly string[],
): Promise<BlockersCard[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "timezone"])
    .where("id", "in", [...projectIds])
    .execute();
  const tasks = await db
    .selectFrom("tasks")
    .leftJoin("blockers", "blockers.task_id", "tasks.id")
    .leftJoin("issue_pull_requests", "issue_pull_requests.issue_id", "tasks.issue_id")
    .leftJoin("check_runs", "check_runs.pull_request_id", "issue_pull_requests.id")
    .select([
      "tasks.id as task_id",
      "tasks.project_id as project_id",
      "tasks.title as title",
      "tasks.issue_id as issue_id",
      "blockers.reason as reason",
      "blockers.required_action as required_action",
      "blockers.signal_type as signal_type",
      "issue_pull_requests.pull_request_number as pull_request_number",
      "check_runs.conclusion as conclusion",
    ])
    .where("tasks.project_id", "in", [...projectIds])
    .where("tasks.status", "=", "BLOCKED")
    .execute();
  const waiting = await db
    .selectFrom("issue_dependencies")
    .innerJoin("issues as waiting", "waiting.id", "issue_dependencies.issue_id")
    .select([
      "issue_dependencies.depends_on_issue_id as blocked_issue_id",
      "waiting.title as title",
    ])
    .where("issue_dependencies.link_type", "=", "blocked_by")
    .where("waiting.state", "=", "open")
    .execute();
  const events = await db
    .selectFrom("events")
    .select(["event_type", "occurred_at", "payload"])
    .where("event_type", "in", [
      EVENT_TYPES.BLOCKER_DETECTED,
      EVENT_TYPES.BLOCKER_DECLARED,
      EVENT_TYPES.GITHUB_CHECKS_FAILED,
      EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED,
    ])
    .execute();
  const byTask = new Map<string, TaskAcc>();
  for (const row of tasks) {
    const current = byTask.get(row.task_id) ?? accOf(row);
    if (row.reason !== null && row.reason.length > 0) {
      current.reason = row.reason;
    }
    if (row.required_action !== null && row.required_action.length > 0) {
      current.requiredAction = row.required_action;
    }
    if (row.pull_request_number !== null) {
      current.pullRequestNumber = row.pull_request_number;
    }
    if (
      row.conclusion === "failure" ||
      row.conclusion === "timed_out" ||
      row.conclusion === "cancelled"
    ) {
      current.ciRed = true;
    }
    if (row.signal_type === "no_branch") {
      current.noBranch = true;
    }
    if (row.signal_type === "no_issue_activity") {
      current.noIssueActivity = true;
    }
    byTask.set(row.task_id, current);
  }
  const waitingTitles = new Map<string, string[]>();
  for (const row of waiting) {
    const titles = waitingTitles.get(row.blocked_issue_id) ?? [];
    titles.push(row.title);
    waitingTitles.set(row.blocked_issue_id, titles);
  }
  const failedPrs = new Set<number>();
  const prUpdatedAt = new Map<number, string>();
  for (const event of events) {
    if (event.event_type === EVENT_TYPES.GITHUB_CHECKS_FAILED) {
      const pr = numberField(event.payload, "pull_request_number");
      if (pr !== undefined) {
        failedPrs.add(pr);
      }
      continue;
    }
    if (event.event_type === EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED) {
      const pr = numberField(event.payload, "pull_request_number");
      const updated = stringField(event.payload, "updated_at");
      if (pr !== undefined && updated !== undefined) {
        const previous = prUpdatedAt.get(pr);
        if (previous === undefined || updated > previous) {
          prUpdatedAt.set(pr, updated);
        }
      }
      continue;
    }
    const taskId = stringField(event.payload, "task_id");
    if (taskId === undefined) {
      continue;
    }
    const current = byTask.get(taskId);
    if (current === undefined) {
      continue;
    }
    if (event.event_type === EVENT_TYPES.BLOCKER_DECLARED) {
      const reason = stringField(event.payload, "reason");
      if (reason !== undefined && reason.length > 0 && current.reason === null) {
        current.reason = reason;
      }
    }
    if (event.event_type === EVENT_TYPES.BLOCKER_DETECTED) {
      const iso = stringField(event.payload, "detected_at") ?? occurredIso(event.occurred_at);
      if (iso !== null && (current.detectedAt === null || iso < current.detectedAt)) {
        current.detectedAt = iso;
      }
      const signal = stringField(event.payload, "signal_type");
      if (signal === "no_branch") {
        current.noBranch = true;
      }
      if (signal === "no_issue_activity") {
        current.noIssueActivity = true;
      }
      if (signal === "ci_red") {
        current.ciRed = true;
      }
    }
  }
  return projects.map((project) => {
    const today = clock.calendarDate(project.timezone);
    const declared: DeclaredBlockerItem[] = [];
    const stale: StaleBlockerItem[] = [];
    for (const item of byTask.values()) {
      if (item.projectId !== project.id) {
        continue;
      }
      if (item.pullRequestNumber !== null && failedPrs.has(item.pullRequestNumber)) {
        item.ciRed = true;
      }
      const idleIso =
        item.pullRequestNumber !== null
          ? (prUpdatedAt.get(item.pullRequestNumber) ?? item.detectedAt)
          : item.detectedAt;
      const idleDays =
        idleIso === null
          ? null
          : clock.daysBetween(
              clock.calendarDateAt(idleIso, project.timezone),
              today,
            );
      if (item.reason !== null) {
        declared.push({
          title: item.title,
          reason: item.reason,
          waitingIssueTitles: waitingTitles.get(item.issueId) ?? [],
          requiredAction: item.requiredAction,
        });
        continue;
      }
      stale.push({
        title: item.title,
        pullRequestNumber: item.pullRequestNumber,
        idleDays: idleDays === null || idleDays <= 0 ? null : idleDays,
        ciRed: item.ciRed,
        noBranch: item.noBranch && item.pullRequestNumber === null,
        noIssueActivity: item.noIssueActivity,
      });
    }
    return {
      projectId: project.id,
      name: project.name,
      declared,
      stale,
    };
  });
}
