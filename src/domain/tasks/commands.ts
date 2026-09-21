import { constants, type Priority } from "../../config/index.js";
import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { DomainError } from "../shared/errors.js";
import { assertAssignee, assertLeadOfProject } from "./access.js";
import {
  closeActiveBlockers,
  hasActiveBlocker,
  type BlockerResolvedEvent,
} from "./blockers.js";
import { pickIssueFromMirror } from "./issue.js";
import { transitionStatus } from "./transitions.js";
import type {
  ActorRole,
  Blocker,
  IssueRef,
  MemberRef,
  ProjectActor,
  Task,
} from "./types.js";

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

export type TaskCheckedEvent = {
  type: typeof EVENT_TYPES.TASK_CHECKED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.checked"];
  idempotencyKey: string;
};

export type TaskUncheckedEvent = {
  type: typeof EVENT_TYPES.TASK_UNCHECKED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.unchecked"];
  idempotencyKey: string;
};

export type TaskConfirmedEvent = {
  type: typeof EVENT_TYPES.TASK_CONFIRMED;
  actor: { id: string; role: ActorRole };
  subject: { entity: "Task"; id: string };
  payload: PayloadByType["task.confirmed"];
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
  pickIssueFromMirror(
    input.issue === undefined ? [] : [input.issue],
    input.projectId,
    input.issueId,
  );
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

export function checkTask(input: {
  task: Task;
  blockers: readonly Blocker[];
  listItemId: string;
  actor: ProjectActor;
  idempotencyKey: string;
}): {
  task: Task;
  blockers: Blocker[];
  events: Array<TaskCheckedEvent | BlockerResolvedEvent>;
} {
  assertAssignee(input.task, input.actor);
  const closed = closeActiveBlockers(input.task, input.blockers, "checked");
  const task = transitionStatus(input.task, "REVIEW");
  return {
    task,
    blockers: closed.blockers,
    events: [
      ...closed.events,
      {
        type: EVENT_TYPES.TASK_CHECKED,
        actor: { id: input.actor.userId, role: input.actor.role },
        subject: { entity: "Task", id: task.id },
        payload: { task_id: task.id, list_item_id: input.listItemId },
        idempotencyKey: input.idempotencyKey,
      },
    ],
  };
}

export function uncheckTask(input: {
  task: Task;
  listItemId: string;
  actor: ProjectActor;
  idempotencyKey: string;
}): { task: Task; event: TaskUncheckedEvent } {
  assertAssignee(input.task, input.actor);
  const task = transitionStatus(input.task, "IN_PROGRESS");
  return {
    task,
    event: {
      type: EVENT_TYPES.TASK_UNCHECKED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: task.id },
      payload: { task_id: task.id, list_item_id: input.listItemId },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function confirmTask(input: {
  task: Task;
  blockers: readonly Blocker[];
  actor: ProjectActor;
}): { task: Task; event: TaskConfirmedEvent } {
  assertLeadOfProject(input.task, input.actor);
  if (hasActiveBlocker(input.blockers.filter((blocker) => blocker.taskId === input.task.id))) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  const task = transitionStatus(input.task, "DONE");
  return {
    task,
    event: {
      type: EVENT_TYPES.TASK_CONFIRMED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Task", id: task.id },
      payload: { task_id: task.id, confirmed_by: input.actor.userId },
      idempotencyKey: `${task.id}:confirmed`,
    },
  };
}
