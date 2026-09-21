import { expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  BLOCKER_SIGNALS,
  checkTask,
  confirmTask,
  createTask,
  detectBlocker,
  resolveBlocker,
  type Blocker,
  type ProjectActor,
  type Task,
} from "../../src/domain/tasks/index.js";
import { EVENT_TYPES } from "../../src/events/generated/event-types.js";

const issue = { id: "issue-1", projectId: "proj-1" };
const assignee = { projectId: "proj-1", userId: "u-a" };
const member: ProjectActor = {
  userId: "u-a",
  role: "member",
  projectId: "proj-1",
};
const lead: ProjectActor = {
  userId: "u-lead",
  role: "lead",
  projectId: "proj-1",
};

function inProgress(): Task {
  return createTask({
    id: "task-1",
    projectId: "proj-1",
    issueId: issue.id,
    assigneeId: assignee.userId,
    title: "Шаг",
    createdByUserId: member.userId,
    target: "today",
    issue,
    assignee,
    actor: member,
    idempotencyKey: "cb-1",
  }).task;
}

function inReview(task = inProgress()): { task: Task; blockers: Blocker[] } {
  const checked = checkTask({
    task,
    blockers: [],
    listItemId: "item-1",
    actor: member,
    idempotencyKey: "cb-check",
  });
  return { task: checked.task, blockers: checked.blockers };
}

it("INV-04: member не подтверждает DONE", () => {
  const { task, blockers } = inReview();
  try {
    confirmTask({ task, blockers, actor: member });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("role_denied");
  }
});

it("INV-04: lead другого проекта не подтверждает DONE", () => {
  const { task, blockers } = inReview();
  try {
    confirmTask({
      task,
      blockers,
      actor: { userId: "u-other", role: "lead", projectId: "other" },
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("role_denied");
  }
});

it("INV-04: lead того же проекта подтверждает DONE", () => {
  const { task, blockers } = inReview();
  const done = confirmTask({ task, blockers, actor: lead });
  expect(done.task.status).toBe("DONE");
  expect(done.event.type).toBe(EVENT_TYPES.TASK_CONFIRMED);
});

it("INV-04: последовательность github-сигналов не ставит DONE", () => {
  const signals = BLOCKER_SIGNALS;
  for (let round = 0; round < signals.length; round += 1) {
    let task = inProgress();
    let blockers: Blocker[] = [];
    for (let step = 0; step < signals.length; step += 1) {
      const signal = signals[(round + step) % signals.length];
      if (signal === undefined) {
        continue;
      }
      if (task.status === "IN_PROGRESS" || task.status === "BLOCKED") {
        const detected = detectBlocker({
          task,
          blockers,
          blockerId: `b-${round}-${step}`,
          signalType: signal,
          detectedAt: "2026-09-21T00:00:00.000Z",
          detectedOnDate: "2026-09-21",
        });
        task = detected.task;
        blockers = detected.blockers;
      }
      const active = blockers.find((blocker) => blocker.active);
      if (active !== undefined && step % 2 === 1) {
        const resolved = resolveBlocker({
          task,
          blockers,
          blockerId: active.id,
          resolvedBySignal: "activity_resumed",
        });
        task = resolved.task;
        blockers = resolved.blockers;
      }
    }
    expect(task.status).not.toBe("DONE");
    expect(task.status === "IN_PROGRESS" || task.status === "BLOCKED").toBe(
      true,
    );
  }
});
