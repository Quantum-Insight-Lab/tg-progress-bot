import { weightOf } from "../tasks/weight.js";
import { NO_PROGRESS_LABEL, type DynamicsPoint, type ProgressTask } from "./types.js";

function ofScope(
  tasks: readonly ProgressTask[],
  projectId: string | undefined,
): ProgressTask[] {
  return tasks.filter(
    (task) =>
      (projectId === undefined || task.projectId === projectId) &&
      task.status !== "CANCELLED",
  );
}

function ratioOf(tasks: readonly ProgressTask[]): number | null {
  let doneWeight = 0;
  let totalWeight = 0;
  for (const task of tasks) {
    const weight = weightOf(task.priority);
    totalWeight += weight;
    if (task.status === "DONE") {
      doneWeight += weight;
    }
  }
  if (totalWeight === 0) {
    return null;
  }
  return doneWeight / totalWeight;
}

/** INV-10: только задачи этого проекта, CANCELLED не в знаменателе. */
export function progressOfProject(
  projectId: string,
  tasks: readonly ProgressTask[],
): number | null {
  return ratioOf(ofScope(tasks, projectId));
}

/** Общий процент для отчётов: та же формула по всем проектам сразу, не сумма процентов. */
export function progressOfAllProjectsForReport(
  tasks: readonly ProgressTask[],
): number | null {
  return ratioOf(ofScope(tasks, undefined));
}

export function taskCountsOfProject(
  projectId: string,
  tasks: readonly ProgressTask[],
): { tasksTotal: number; tasksDone: number } {
  const scoped = ofScope(tasks, projectId);
  return {
    tasksTotal: scoped.length,
    tasksDone: scoped.filter((task) => task.status === "DONE").length,
  };
}

/** INV-11: пустой знаменатель — не процент. */
export function formatProgress(progress: number | null): string {
  if (progress === null) {
    return NO_PROGRESS_LABEL;
  }
  return String(progress);
}

/** INV-11: пропуски дат не заполняются. */
export function dynamicsSeries(
  snapshots: readonly DynamicsPoint[],
): DynamicsPoint[] {
  return [...snapshots].sort((left, right) =>
    left.snapshotDate.localeCompare(right.snapshotDate),
  );
}
