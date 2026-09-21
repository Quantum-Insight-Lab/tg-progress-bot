/** Контекст progress. Читает вес из tasks, не пишет в журнал. */

export type {
  DynamicsPoint,
  ProgressSnapshot,
  ProgressSnapshotTakenEvent,
  ProgressTask,
} from "./types.js";
export { NO_PROGRESS_LABEL, PROGRESS_ACTOR } from "./types.js";
export {
  dynamicsSeries,
  formatProgress,
  progressOfAllProjectsForReport,
  progressOfProject,
  taskCountsOfProject,
} from "./calc.js";
export { takeProgressSnapshot } from "./snapshot.js";
