import { DomainError } from "../shared/errors.js";
import type { Task, TaskStatus } from "./types.js";

/** INV-03: таблица из docs/04 без REVIEW/DONE/BLOCKED — их добавит #9. */
export function isAllowedTransition(
  from: TaskStatus | null,
  to: TaskStatus,
): boolean {
  if (from === to) {
    return false;
  }
  if (from === null) {
    return to === "IN_PROGRESS" || to === "PLANNED";
  }
  if (to === "CANCELLED") {
    return from !== "DONE";
  }
  if (from === "PLANNED" && to === "IN_PROGRESS") {
    return true;
  }
  if (from === "IN_PROGRESS" && to === "PLANNED") {
    return true;
  }
  return false;
}

export function transitionStatus(task: Task, to: TaskStatus): Task {
  if (!isAllowedTransition(task.status, to)) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  return { ...task, status: to };
}
