import { expect, it } from "vitest";
import {
  createTask,
  detectBlocker,
  dismissBlocker,
  hasActiveBlocker,
  resolveBlocker,
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

it("INV-13: BLOCKED появляется вместе с активным блокером", () => {
  const detected = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "no_check",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  expect(detected.task.status).toBe("BLOCKED");
  expect(hasActiveBlocker(detected.blockers)).toBe(true);
});

it("INV-13: снятие блокера возвращает IN_PROGRESS", () => {
  const detected = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "no_check",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  const dismissed = dismissBlocker({
    task: detected.task,
    blockers: detected.blockers,
    blockerId: "b1",
    actor: member,
  });
  expect(dismissed.task.status).toBe("IN_PROGRESS");
  expect(hasActiveBlocker(dismissed.blockers)).toBe(false);
});

it("INV-13: resolve последнего блокера тоже возвращает IN_PROGRESS", () => {
  const detected = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "ci_red",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  const resolved = resolveBlocker({
    task: detected.task,
    blockers: detected.blockers,
    blockerId: "b1",
    resolvedBySignal: "ci_green",
  });
  expect(resolved.task.status).toBe("IN_PROGRESS");
  expect(hasActiveBlocker(resolved.blockers)).toBe(false);
});

it("INV-13: второй активный блокер держит BLOCKED", () => {
  const first = detectBlocker({
    task: inProgress(),
    blockers: [],
    blockerId: "b1",
    signalType: "no_check",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  const second = detectBlocker({
    task: first.task,
    blockers: first.blockers,
    blockerId: "b2",
    signalType: "ci_red",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  const dismissed = dismissBlocker({
    task: second.task,
    blockers: second.blockers,
    blockerId: "b1",
    actor: member,
  });
  expect(dismissed.task.status).toBe("BLOCKED");
  expect(hasActiveBlocker(dismissed.blockers)).toBe(true);
});
