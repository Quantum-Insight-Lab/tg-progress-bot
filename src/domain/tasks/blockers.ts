import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";
import { DomainError } from "../shared/errors.js";
import { assertAssignee } from "./access.js";
import { transitionStatus } from "./transitions.js";
import type {
  Blocker,
  BlockerSignal,
  ProjectActor,
  Task,
} from "./types.js";

export type BlockerDetectedEvent = {
  type: typeof EVENT_TYPES.BLOCKER_DETECTED;
  actor: { id: string; role: "system" };
  subject: { entity: "Blocker"; id: string };
  payload: PayloadByType["blocker.detected"];
  idempotencyKey: string;
};

export type BlockerDeclaredEvent = {
  type: typeof EVENT_TYPES.BLOCKER_DECLARED;
  actor: { id: string; role: ProjectActor["role"] };
  subject: { entity: "Blocker"; id: string };
  payload: PayloadByType["blocker.declared"];
  idempotencyKey: string;
};

export type BlockerDismissedEvent = {
  type: typeof EVENT_TYPES.BLOCKER_DISMISSED;
  actor: { id: string; role: ProjectActor["role"] };
  subject: { entity: "Blocker"; id: string };
  payload: PayloadByType["blocker.dismissed"];
  idempotencyKey: string;
};

export type BlockerResolvedEvent = {
  type: typeof EVENT_TYPES.BLOCKER_RESOLVED;
  actor: { id: string; role: "system" };
  subject: { entity: "Blocker"; id: string };
  payload: PayloadByType["blocker.resolved"];
  idempotencyKey: string;
};

export function hasActiveBlocker(blockers: readonly Blocker[]): boolean {
  return blockers.some((blocker) => blocker.active);
}

function blockersOf(taskId: string, blockers: readonly Blocker[]): Blocker[] {
  return blockers.filter((blocker) => blocker.taskId === taskId);
}

function closeBlocker(blocker: Blocker): Blocker {
  return { ...blocker, active: false };
}

function syncBlockedStatus(
  task: Task,
  blockers: readonly Blocker[],
): Task {
  const active = hasActiveBlocker(blockersOf(task.id, blockers));
  if (active && task.status === "IN_PROGRESS") {
    return transitionStatus(task, "BLOCKED");
  }
  if (!active && task.status === "BLOCKED") {
    return transitionStatus(task, "IN_PROGRESS");
  }
  return task;
}

export function detectBlocker(input: {
  task: Task;
  blockers: readonly Blocker[];
  blockerId: string;
  signalType: BlockerSignal;
  detectedAt: string;
  detectedOnDate: string;
}): {
  task: Task;
  blockers: Blocker[];
  event: BlockerDetectedEvent;
} {
  if (input.task.status !== "IN_PROGRESS" && input.task.status !== "BLOCKED") {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  const blocker: Blocker = {
    id: input.blockerId,
    taskId: input.task.id,
    source: "signal",
    signalType: input.signalType,
    reason: null,
    active: true,
  };
  const blockers = [...input.blockers, blocker];
  const task =
    input.task.status === "IN_PROGRESS"
      ? transitionStatus(input.task, "BLOCKED")
      : input.task;
  return {
    task,
    blockers,
    event: {
      type: EVENT_TYPES.BLOCKER_DETECTED,
      actor: { id: "system", role: "system" },
      subject: { entity: "Blocker", id: blocker.id },
      payload: {
        blocker_id: blocker.id,
        task_id: task.id,
        signal_type: input.signalType,
        detected_at: input.detectedAt,
      },
      idempotencyKey: `${task.id}+${input.signalType}+${input.detectedOnDate}`,
    },
  };
}

export function declareBlocker(input: {
  task: Task;
  blockers: readonly Blocker[];
  blockerId: string;
  reason: string;
  actor: ProjectActor;
}): { blockers: Blocker[]; event: BlockerDeclaredEvent } {
  assertAssignee(input.task, input.actor);
  const blockers = input.blockers.map((blocker) => {
    if (blocker.id !== input.blockerId) {
      return blocker;
    }
    if (!blocker.active || blocker.taskId !== input.task.id) {
      throw new DomainError("invalid_transition", "Переход статуса запрещён");
    }
    return { ...blocker, reason: input.reason };
  });
  if (!blockers.some((blocker) => blocker.id === input.blockerId)) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  return {
    blockers,
    event: {
      type: EVENT_TYPES.BLOCKER_DECLARED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Blocker", id: input.blockerId },
      payload: {
        blocker_id: input.blockerId,
        task_id: input.task.id,
        reason: input.reason,
      },
      idempotencyKey: `${input.blockerId}:declared`,
    },
  };
}

export function dismissBlocker(input: {
  task: Task;
  blockers: readonly Blocker[];
  blockerId: string;
  actor: ProjectActor;
}): {
  task: Task;
  blockers: Blocker[];
  event: BlockerDismissedEvent;
} {
  assertAssignee(input.task, input.actor);
  let found = false;
  const blockers = input.blockers.map((blocker) => {
    if (blocker.id !== input.blockerId) {
      return blocker;
    }
    found = true;
    if (!blocker.active || blocker.taskId !== input.task.id) {
      throw new DomainError("invalid_transition", "Переход статуса запрещён");
    }
    return closeBlocker(blocker);
  });
  if (!found) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  return {
    task: syncBlockedStatus(input.task, blockers),
    blockers,
    event: {
      type: EVENT_TYPES.BLOCKER_DISMISSED,
      actor: { id: input.actor.userId, role: input.actor.role },
      subject: { entity: "Blocker", id: input.blockerId },
      payload: { blocker_id: input.blockerId, task_id: input.task.id },
      idempotencyKey: `${input.blockerId}:dismissed`,
    },
  };
}

export function resolveBlocker(input: {
  task: Task;
  blockers: readonly Blocker[];
  blockerId: string;
  resolvedBySignal: PayloadByType["blocker.resolved"]["resolved_by_signal"];
}): {
  task: Task;
  blockers: Blocker[];
  event: BlockerResolvedEvent;
} {
  let found = false;
  const blockers = input.blockers.map((blocker) => {
    if (blocker.id !== input.blockerId) {
      return blocker;
    }
    found = true;
    if (!blocker.active || blocker.taskId !== input.task.id) {
      throw new DomainError("invalid_transition", "Переход статуса запрещён");
    }
    return closeBlocker(blocker);
  });
  if (!found) {
    throw new DomainError("invalid_transition", "Переход статуса запрещён");
  }
  return {
    task: syncBlockedStatus(input.task, blockers),
    blockers,
    event: {
      type: EVENT_TYPES.BLOCKER_RESOLVED,
      actor: { id: "system", role: "system" },
      subject: { entity: "Blocker", id: input.blockerId },
      payload: {
        blocker_id: input.blockerId,
        task_id: input.task.id,
        resolved_by_signal: input.resolvedBySignal,
      },
      idempotencyKey: `${input.blockerId}:resolved`,
    },
  };
}

export function closeActiveBlockers(
  task: Task,
  blockers: readonly Blocker[],
  resolvedBySignal: PayloadByType["blocker.resolved"]["resolved_by_signal"],
): { blockers: Blocker[]; events: BlockerResolvedEvent[] } {
  const events: BlockerResolvedEvent[] = [];
  const next = blockers.map((blocker) => {
    if (!blocker.active || blocker.taskId !== task.id) {
      return blocker;
    }
    events.push({
      type: EVENT_TYPES.BLOCKER_RESOLVED,
      actor: { id: "system", role: "system" },
      subject: { entity: "Blocker", id: blocker.id },
      payload: {
        blocker_id: blocker.id,
        task_id: task.id,
        resolved_by_signal: resolvedBySignal,
      },
      idempotencyKey: `${blocker.id}:resolved`,
    });
    return closeBlocker(blocker);
  });
  return { blockers: next, events };
}
