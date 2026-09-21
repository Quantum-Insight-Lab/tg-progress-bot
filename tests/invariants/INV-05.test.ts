import { expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  checkTask,
  confirmTask,
  createTask,
  detectBlocker,
  type Blocker,
  type ProjectActor,
  type Task,
} from "../../src/domain/tasks/index.js";

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

it("INV-05: DONE при активном блокере запрещён", () => {
  const detected = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "no_check",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  try {
    confirmTask({
      task: { ...detected.task, status: "REVIEW" },
      blockers: detected.blockers,
      actor: lead,
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_transition");
  }
});

it("INV-05: галочка с BLOCKED закрывает блокеры и пускает в REVIEW", () => {
  const detected = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "no_check",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  const checked = checkTask({
    task: detected.task,
    blockers: detected.blockers,
    listItemId: "item-1",
    actor: member,
    idempotencyKey: "cb-check",
  });
  expect(checked.task.status).toBe("REVIEW");
  expect(checked.blockers.every((blocker) => !blocker.active)).toBe(true);
  const done = confirmTask({
    task: checked.task,
    blockers: checked.blockers,
    actor: lead,
  });
  expect(done.task.status).toBe("DONE");
});

it("INV-05: без блокеров lead подтверждает из REVIEW", () => {
  const checked = checkTask({
    task: inProgress(),
    blockers: [] as Blocker[],
    listItemId: "item-1",
    actor: member,
    idempotencyKey: "cb-check",
  });
  expect(
    confirmTask({
      task: checked.task,
      blockers: checked.blockers,
      actor: lead,
    }).task.status,
  ).toBe("DONE");
});
