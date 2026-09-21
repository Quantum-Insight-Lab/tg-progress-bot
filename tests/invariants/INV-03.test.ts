import { expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  TASK_STATUSES,
  cancelTask,
  createTask,
  isAllowedTransition,
  postponeTask,
  transitionStatus,
  type ActorRole,
  type TaskStatus,
} from "../../src/domain/tasks/index.js";

const issue = { id: "issue-1", projectId: "proj-1" };
const assignee = { projectId: "proj-1", userId: "u-a" };
const actor = { userId: "u-author", role: "member" as ActorRole };

function create(target: "today" | "plan") {
  return createTask({
    id: "task-1",
    projectId: "proj-1",
    issueId: issue.id,
    assigneeId: assignee.userId,
    title: "Шаг",
    createdByUserId: actor.userId,
    target,
    issue,
    assignee,
    actor,
    idempotencyKey: "cb-1",
  }).task;
}

it("INV-03: создание сегодня — IN_PROGRESS, в план — PLANNED", () => {
  expect(create("today").status).toBe("IN_PROGRESS");
  expect(create("plan").status).toBe("PLANNED");
});

it("INV-03: PLANNED → IN_PROGRESS и отложить обратно разрешены", () => {
  const planned = create("plan");
  const today = transitionStatus(planned, "IN_PROGRESS");
  expect(today.status).toBe("IN_PROGRESS");
  const postponed = postponeTask({
    task: today,
    fromListId: "list-1",
    actor,
    idempotencyKey: "cb-2",
  }).task;
  expect(postponed.status).toBe("PLANNED");
});

it("INV-03: IN_PROGRESS → REVIEW и BLOCKED разрешены, сразу в DONE — нет", () => {
  const task = create("today");
  expect(transitionStatus(task, "REVIEW").status).toBe("REVIEW");
  expect(transitionStatus(task, "BLOCKED").status).toBe("BLOCKED");
  expect(() => transitionStatus(task, "DONE")).toThrow(DomainError);
});

it("INV-03: любой кроме DONE может быть CANCELLED", () => {
  expect(cancelTask({ task: create("today"), reason: null, actor }).task.status).toBe(
    "CANCELLED",
  );
  expect(cancelTask({ task: create("plan"), reason: null, actor }).task.status).toBe(
    "CANCELLED",
  );
  const done = { ...create("today"), status: "DONE" as TaskStatus };
  expect(() => cancelTask({ task: done, reason: null, actor })).toThrow(
    DomainError,
  );
});

it("INV-03: все пары статусов сходятся с таблицей переходов", () => {
  const allowed = new Set([
    "null>IN_PROGRESS",
    "null>PLANNED",
    "PLANNED>IN_PROGRESS",
    "IN_PROGRESS>PLANNED",
    "IN_PROGRESS>BLOCKED",
    "BLOCKED>IN_PROGRESS",
    "IN_PROGRESS>REVIEW",
    "BLOCKED>REVIEW",
    "REVIEW>IN_PROGRESS",
    "REVIEW>DONE",
    "PLANNED>CANCELLED",
    "IN_PROGRESS>CANCELLED",
    "BLOCKED>CANCELLED",
    "REVIEW>CANCELLED",
  ]);
  expect(isAllowedTransition(null, "IN_PROGRESS")).toBe(true);
  expect(isAllowedTransition(null, "PLANNED")).toBe(true);
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const key = `${from}>${to}`;
      expect(isAllowedTransition(from, to)).toBe(allowed.has(key));
    }
  }
});
