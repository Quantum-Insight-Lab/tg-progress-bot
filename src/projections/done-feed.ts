import { EVENT_TYPES } from "../events/generated/event-types.js";
import { getDb } from "../infrastructure/db.js";
import { dateLabel } from "./dates.js";
import { occurredIso, stringField } from "./payload.js";
import type { DoneCard } from "./types.js";

export async function doneFeed(
  projectIds: readonly string[],
): Promise<DoneCard[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "timezone"])
    .where("id", "in", [...projectIds])
    .execute();
  const items = await db
    .selectFrom("tasks")
    .innerJoin("issues", "issues.id", "tasks.issue_id")
    .leftJoin("issue_pull_requests", "issue_pull_requests.issue_id", "issues.id")
    .select([
      "tasks.id as task_id",
      "tasks.project_id as project_id",
      "tasks.title as title",
      "issues.issue_number as issue_number",
      "issue_pull_requests.pull_request_number as pull_request_number",
    ])
    .where("tasks.project_id", "in", [...projectIds])
    .where("tasks.status", "=", "DONE")
    .execute();
  const confirms = await db
    .selectFrom("events")
    .select(["occurred_at", "payload"])
    .where("event_type", "=", EVENT_TYPES.TASK_CONFIRMED)
    .execute();
  const confirmedAt = new Map<string, string>();
  for (const event of confirms) {
    const taskId = stringField(event.payload, "task_id");
    const iso = occurredIso(event.occurred_at);
    if (taskId === undefined || iso === null) {
      continue;
    }
    const previous = confirmedAt.get(taskId);
    if (previous === undefined || iso > previous) {
      confirmedAt.set(taskId, iso);
    }
  }
  return projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    items: items
      .filter((item) => item.project_id === project.id)
      .map((item) => {
        const iso = confirmedAt.get(item.task_id);
        return {
          title: item.title,
          confirmedLabel:
            iso === undefined ? null : dateLabel(iso, project.timezone),
          issueNumber: item.issue_number,
          pullRequestNumber: item.pull_request_number,
        };
      }),
  }));
}
