import { sql } from "kysely";
import { getDb } from "../infrastructure/db.js";
import { clock } from "../infrastructure/clock.js";
import { dayNumberOf } from "./day-number.js";
import type { WorkCard } from "./types.js";

export async function workBoard(
  projectIds: readonly string[],
): Promise<WorkCard[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const db = getDb();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "timezone"])
    .where("id", "in", [...projectIds])
    .execute();
  const lists = await db
    .selectFrom("task_list_items")
    .innerJoin("task_lists", "task_lists.id", "task_list_items.list_id")
    .innerJoin("tasks", "tasks.id", "task_list_items.task_id")
    .innerJoin("issues", "issues.id", "tasks.issue_id")
    .innerJoin("users", "users.id", "tasks.assignee_id")
    .leftJoin("issue_pull_requests", "issue_pull_requests.issue_id", "issues.id")
    .select([
      "tasks.project_id as project_id",
      "tasks.title as title",
      "users.github_login as github_login",
      "task_list_items.task_id as task_id",
      "task_list_items.list_id as list_id",
      "task_list_items.carried_from_list_id as carried_from_list_id",
      "issues.issue_number as issue_number",
      "issue_pull_requests.pull_request_number as pull_request_number",
      sql<string>`task_lists.list_date::text`.as("list_date"),
      "task_list_items.is_done as is_done",
    ])
    .where("tasks.project_id", "in", [...projectIds])
    .where("task_list_items.is_done", "=", false)
    .execute();
  const chain = await db
    .selectFrom("task_list_items")
    .select(["task_id", "list_id", "carried_from_list_id"])
    .where("project_id", "in", [...projectIds])
    .execute();
  const chainItems = chain.map((row) => ({
    taskId: row.task_id,
    listId: row.list_id,
    carriedFromListId: row.carried_from_list_id,
  }));
  return projects.map((project) => {
    const today = clock.calendarDate(project.timezone);
    return {
      projectId: project.id,
      name: project.name,
      items: lists
        .filter((item) => item.project_id === project.id && item.list_date === today)
        .map((item) => ({
          title: item.title,
          assigneeLogin: item.github_login,
          dayNumber: dayNumberOf(
            {
              taskId: item.task_id,
              listId: item.list_id,
              carriedFromListId: item.carried_from_list_id,
            },
            chainItems,
          ),
          issueNumber: item.issue_number,
          pullRequestNumber: item.pull_request_number,
        })),
    };
  });
}
