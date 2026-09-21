import { getDb } from "../infrastructure/db.js";
import type { PlanCard } from "./types.js";

export async function planQueue(
  projectIds: readonly string[],
): Promise<PlanCard[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name"])
    .where("id", "in", [...projectIds])
    .execute();
  const items = await db
    .selectFrom("tasks")
    .select(["project_id", "title", "priority", "issue_id"])
    .where("project_id", "in", [...projectIds])
    .where("status", "=", "PLANNED")
    .execute();
  const deps = await db
    .selectFrom("issue_dependencies")
    .innerJoin("issues as blocker", "blocker.id", "issue_dependencies.depends_on_issue_id")
    .select([
      "issue_dependencies.issue_id as issue_id",
      "blocker.state as blocker_state",
    ])
    .where("issue_dependencies.link_type", "=", "blocked_by")
    .execute();
  const blocked = new Set(
    deps.filter((row) => row.blocker_state === "open").map((row) => row.issue_id),
  );
  return projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    items: items
      .filter((item) => item.project_id === project.id)
      .map((item) => ({
        title: item.title,
        priority: item.priority,
        issueId: item.issue_id,
        blockedByOpenIssue: blocked.has(item.issue_id),
      })),
  }));
}
