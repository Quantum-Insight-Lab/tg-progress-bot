import { getDb } from "../infrastructure/db.js";
import type { GithubCard } from "./types.js";

export async function githubState(
  projectIds: readonly string[],
): Promise<GithubCard[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name"])
    .where("id", "in", [...projectIds])
    .execute();
  const issues = await db
    .selectFrom("issues")
    .leftJoin("tasks", "tasks.issue_id", "issues.id")
    .select(["issues.project_id as project_id", "issues.issue_number as issue_number", "issues.title as title"])
    .where("issues.project_id", "in", [...projectIds])
    .where("issues.state", "=", "open")
    .where("tasks.id", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("issue_pull_requests")
            .select("issue_pull_requests.id")
            .whereRef("issue_pull_requests.project_id", "=", "issues.project_id")
            .whereRef(
              "issue_pull_requests.pull_request_number",
              "=",
              "issues.issue_number",
            ),
        ),
      ),
    )
    .execute();
  const pulls = await db
    .selectFrom("issue_pull_requests")
    .select(["project_id", "pull_request_number"])
    .where("project_id", "in", [...projectIds])
    .where("state", "=", "open")
    .execute();
  const checks = await db
    .selectFrom("check_runs")
    .innerJoin(
      "issue_pull_requests",
      "issue_pull_requests.id",
      "check_runs.pull_request_id",
    )
    .select([
      "issue_pull_requests.project_id as project_id",
      "issue_pull_requests.pull_request_number as pull_request_number",
      "check_runs.conclusion as conclusion",
    ])
    .where("issue_pull_requests.project_id", "in", [...projectIds])
    .where("check_runs.conclusion", "in", ["failure", "timed_out", "cancelled"])
    .execute();
  return projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    issuesWithoutTasks: issues
      .filter((issue) => issue.project_id === project.id)
      .map((issue) => ({ number: issue.issue_number, title: issue.title })),
    openPullRequests: pulls
      .filter((pull) => pull.project_id === project.id)
      .map((pull) => ({ number: pull.pull_request_number })),
    failingChecks: checks
      .filter((check) => check.project_id === project.id)
      .map((check) => ({
        pullRequestNumber: check.pull_request_number,
        conclusion: check.conclusion ?? "failure",
      })),
  }));
}
