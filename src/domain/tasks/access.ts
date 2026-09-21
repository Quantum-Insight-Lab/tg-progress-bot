import { DomainError } from "../shared/errors.js";
import type { ProjectActor, Task } from "./types.js";

export function assertAssignee(task: Task, actor: ProjectActor): void {
  if (actor.projectId !== task.projectId) {
    throw new DomainError("not_a_member", "Нет доступа");
  }
  if (actor.userId !== task.assigneeId) {
    throw new DomainError("role_denied", "Нет доступа");
  }
}

export function assertLeadOfProject(task: Task, actor: ProjectActor): void {
  if (actor.projectId !== task.projectId) {
    throw new DomainError("role_denied", "Нет доступа");
  }
  if (actor.role !== "lead") {
    throw new DomainError("role_denied", "Нет доступа");
  }
}
