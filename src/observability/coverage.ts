import { constants } from "../config/index.js";
import { getDb } from "../infrastructure/db.js";

export function coverageGapWarns(gap: number | null): boolean {
  if (gap === null) {
    return false;
  }
  return gap > constants.coverageGapWarnRatio;
}

export const COVERAGE_GAP_WARNING = "⚠ много issues без задач";

export async function coverageGapByProject(
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (projectIds.length === 0) {
    return result;
  }
  const db = getDb();
  const issues = await db
    .selectFrom("issues")
    .select(["id", "project_id"])
    .where("project_id", "in", [...projectIds])
    .where("state", "=", "open")
    .execute();
  const linked = await db
    .selectFrom("tasks")
    .select("issue_id")
    .where("project_id", "in", [...projectIds])
    .execute();
  const withTask = new Set(linked.map((row) => row.issue_id));
  for (const projectId of projectIds) {
    const open = issues.filter((issue) => issue.project_id === projectId);
    if (open.length === 0) {
      result.set(projectId, 0);
      continue;
    }
    const missing = open.filter((issue) => !withTask.has(issue.id)).length;
    result.set(projectId, missing / open.length);
  }
  return result;
}

export async function coverageGapOverall(): Promise<number | null> {
  const db = getDb();
  const issues = await db
    .selectFrom("issues")
    .select("id")
    .where("state", "=", "open")
    .execute();
  if (issues.length === 0) {
    return 0;
  }
  const linked = await db.selectFrom("tasks").select("issue_id").execute();
  const withTask = new Set(linked.map((row) => row.issue_id));
  const missing = issues.filter((issue) => !withTask.has(issue.id)).length;
  return missing / issues.length;
}
