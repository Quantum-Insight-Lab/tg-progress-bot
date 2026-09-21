import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import type { Priority } from "../../config/index.js";
import type { TaskStatus } from "../tasks/types.js";

export const PROGRESS_ACTOR = { id: "system", role: "system" } as const;

export const NO_PROGRESS_LABEL = "Нет данных";

export type ProgressTask = {
  projectId: string;
  status: TaskStatus;
  priority: Priority;
};

export type ProgressSnapshot = {
  id: string;
  projectId: string;
  progress: number | null;
  tasksTotal: number;
  tasksDone: number;
  snapshotDate: string;
  createdAt: string;
};

export type ProgressSnapshotTakenEvent = {
  type: typeof EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN;
  actor: typeof PROGRESS_ACTOR;
  subject: { entity: "ProgressSnapshot"; id: string };
  payload: PayloadByType["progress.snapshot_taken"];
  idempotencyKey: string;
};

export type DynamicsPoint = {
  snapshotDate: string;
  progress: number | null;
};
