import { EVENT_TYPE_VALUES } from "../events/generated/event-types.js";
import { getDb } from "../infrastructure/db.js";
import { dateLabel } from "./dates.js";
import { occurredIso, stringField } from "./payload.js";
import type { ProjectProgressCard } from "./types.js";

const TASK_EVENT_TYPES = EVENT_TYPE_VALUES.filter((type) =>
  type.startsWith("task."),
);

export async function projectProgress(
  projectIds: readonly string[],
): Promise<ProjectProgressCard[]> {
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
    .select(["id", "project_id", "status", "priority", "title"])
    .where("project_id", "in", [...projectIds])
    .execute();
  const stages = await db
    .selectFrom("stages")
    .select(["project_id", "name", "sort_order", "status"])
    .where("project_id", "in", [...projectIds])
    .where("status", "=", "open")
    .execute();
  const events = await db
    .selectFrom("events")
    .select(["occurred_at", "payload"])
    .where("event_type", "in", [...TASK_EVENT_TYPES])
    .execute();
  const projectByTask = new Map(
    tasks.map((task) => [task.id, task.project_id] as const),
  );
  const latest = new Map<string, string>();
  for (const event of events) {
    const fromPayload = stringField(event.payload, "project_id");
    const taskId = stringField(event.payload, "task_id");
    const projectId =
      fromPayload ?? (taskId !== undefined ? projectByTask.get(taskId) : undefined);
    if (projectId === undefined) {
      continue;
    }
    const iso = occurredIso(event.occurred_at);
    if (iso === null) {
      continue;
    }
    const previous = latest.get(projectId);
    if (previous === undefined || iso > previous) {
      latest.set(projectId, iso);
    }
  }
  return projects.map((project) => {
    const ofProject = tasks.filter((task) => task.project_id === project.id);
    const stage = stages
      .filter((row) => row.project_id === project.id)
      .sort((left, right) => left.sort_order - right.sort_order)[0];
    const lastChangeAt = latest.get(project.id) ?? null;
    return {
      projectId: project.id,
      name: project.name,
      tasks: ofProject.map((task) => ({
        projectId: task.project_id,
        title: task.title,
        status: task.status,
        priority: task.priority,
      })),
      stageName: stage?.name ?? null,
      lastChangeAt,
      lastChangeLabel:
        lastChangeAt === null ? null : dateLabel(lastChangeAt, project.timezone),
    };
  });
}
