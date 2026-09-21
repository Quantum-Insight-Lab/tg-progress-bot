import { constants, type Priority } from "../../config/index.js";
import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { DomainError } from "../shared/errors.js";
import { transitionStatus } from "./transitions.js";
import type { ActorRole, IssueRef, MemberRef, Task } from "./types.js";

export type TaskCreatedEvent = {
  type: typeof EVENT_TYPES.TASK_CREATED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.created"];
  idempotencyKey: string;
};

export type TaskPrioritizedEvent = {
  type: typeof EVENT_TYPES.TASK_PRIORITIZED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.prioritized"];
  idempotencyKey: string;
};

export type TaskReassignedEvent = {
  type: typeof EVENT_TYPES.TASK_REASSIGNED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.reassigned"];
  idempotencyKey: string;
};

export type TaskPostponedEvent = {
  type: typeof EVENT_TYPES.TASK_POSTPONED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.postponed"];
  idempotencyKey: string;
};

export type TaskCancelledEvent = {
  type: typeof EVENT_TYPES.TASK_CANCELLED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.cancelled"];
  idempotencyKey: string;
};

function assertActorCanWrite(role: ActorRole): void {
  if (role === "viewer") {
    throw new DomainError("role_denied", "Нет доступа");
  }
}

export function createTask(input: {
  id: string;
  projectId: string;
  issueId: string;
  assigneeId: string;
  title: string;
  createdByUserId: string;
  target: "today" | "plan";
  priority?: Priority;
  issue: IssueRef | undefined;
  assignee: MemberRef | undefined;
  actor: { userId: string; role: ActorRole };
  idempotencyKey: string;
}): { task: Task; event: TaskCreatedEvent } {
  assertActorCanWrite(input.actor.role);
  if (
    input.issue === undefined ||
    input.issue.id !== input.issueId ||
    input.issue.projectId !== input.projectId
  ) {
    throw new DomainError("invalid_transition", "Нужен issue своего проекта");
  }
  if (
    input.assignee === undefined ||
    input.assignee.userId !== input.assigneeId ||
    input.assignee.projectId !== input.projectId
  ) {
    throw new DomainError("not_a_member", "Нет доступа");
  }
  const priority = input.priority ?? constants.defaultPriority;
  const status = input.target === "today" ? "IN_PROGRESS" : "PLANNED";
  const task: Task = {
    id: input.id,
    projectId: input.projectId,
    issueId: input.issueId,
    assigneeId: input.assigneeId,
    title: input.title,
    status,
    priority,
    createdByUserId: input.createdByUserId,
  };
  return {
    task,
    event: {
      type: EVENT_TYPES.TASK_CREATED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: task.id },
      payload: {
        task_id: task.id,
        project_id: task.projectId,
        issue_id: task.issueId,
        title: task.title,
        assignee_id: task.assigneeId,
        priority: task.priority,
        target: input.target,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function prioritizeTask(input: {
  task: Task;
  priority: Priority;
  actor: { userId: string; role: ActorRole };
  idempotencyKey: string;
}): { task: Task; applied: boolean; event: TaskPrioritizedEvent | null } {
  assertActorCanWrite(input.actor.role);
  if (input.task.priority === input.priority) {
    return { task: input.task, applied: false, event: null };
  }
  return {
    task: { ...input.task, priority: input.priority },
    applied: true,
    event: {
      type: EVENT_TYPES.TASK_PRIORITIZED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: input.task.id },
      payload: {
        task_id: input.task.id,
        priority: input.priority,
        previous_priority: input.task.priority,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function reassignTask(input: {
  task: Task;
  assigneeId: string;
  assignee: MemberRef | undefined;
  actor: { userId: string; role: ActorRole };
  idempotencyKey: string;
}): { task: Task; applied: boolean; event: TaskReassignedEvent | null } {
  if (input.actor.role !== "lead") {
    throw new DomainError("role_denied", "Нет доступа");
  }
  if (
    input.assignee === undefined ||
    input.assignee.userId !== input.assigneeId ||
    input.assignee.projectId !== input.task.projectId
  ) {
    throw new DomainError("not_a_member", "Нет доступа");
  }
  if (input.task.assigneeId === input.assigneeId) {
    return { task: input.task, applied: false, event: null };
  }
  return {
    task: { ...input.task, assigneeId: input.assigneeId },
    applied: true,
    event: {
      type: EVENT_TYPES.TASK_REASSIGNED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: input.task.id },
      payload: {
        task_id: input.task.id,
        assignee_id: input.assigneeId,
        previous_assignee_id: input.task.assigneeId,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function postponeTask(input: {
  task: Task;
  fromListId: string | null;
  actor: { userId: string; role: ActorRole };
  idempotencyKey: string;
}): { task: Task; event: TaskPostponedEvent } {
  if (input.actor.userId !== input.task.createdByUserId) {
    throw new DomainError("role_denied", "Нет доступа");
  }
  const task = transitionStatus(input.task, "PLANNED");
  return {
    task,
    event: {
      type: EVENT_TYPES.TASK_POSTPONED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: task.id },
      payload: { task_id: task.id, from_list_id: input.fromListId },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function cancelTask(input: {
  task: Task;
  reason: string | null;
  actor: { userId: string; role: ActorRole };
}): { task: Task; event: TaskCancelledEvent } {
  const isAuthor = input.actor.userId === input.task.createdByUserId;
  if (!isAuthor && input.actor.role !== "lead") {
    throw new DomainError("role_denied", "Нет доступа");
  }
  const task = transitionStatus(input.task, "CANCELLED");
  return {
    task,
    event: {
      type: EVENT_TYPES.TASK_CANCELLED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: task.id },
      payload: {
        task_id: task.id,
        cancelled_by: input.actor.userId,
        reason: input.reason,
      },
      idempotencyKey: `${task.id}:cancelled`,
    },
  };
}
