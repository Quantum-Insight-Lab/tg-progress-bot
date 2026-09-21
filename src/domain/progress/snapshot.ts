import { EVENT_TYPES } from "../../events/generated/event-types.js";
import {
  progressOfProject,
  taskCountsOfProject,
} from "./calc.js";
import {
  PROGRESS_ACTOR,
  type ProgressSnapshot,
  type ProgressSnapshotTakenEvent,
  type ProgressTask,
} from "./types.js";

export function takeProgressSnapshot(input: {
  id: string;
  projectId: string;
  tasks: readonly ProgressTask[];
  snapshotDate: string;
  createdAt: string;
}): { snapshot: ProgressSnapshot; event: ProgressSnapshotTakenEvent } {
  const progress = progressOfProject(input.projectId, input.tasks);
  const counts = taskCountsOfProject(input.projectId, input.tasks);
  const snapshot: ProgressSnapshot = {
    id: input.id,
    projectId: input.projectId,
    progress,
    tasksTotal: counts.tasksTotal,
    tasksDone: counts.tasksDone,
    snapshotDate: input.snapshotDate,
    createdAt: input.createdAt,
  };
  return {
    snapshot,
    event: {
      type: EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN,
      actor: PROGRESS_ACTOR,
      subject: { entity: "ProgressSnapshot", id: snapshot.id },
      payload: {
        project_id: snapshot.projectId,
        progress: snapshot.progress,
        tasks_total: snapshot.tasksTotal,
        tasks_done: snapshot.tasksDone,
      },
      idempotencyKey: `${snapshot.projectId}:${snapshot.snapshotDate}`,
    },
  };
}
