import { expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import {
  applyStaleSignals,
  createTask,
  detectBlocker,
  dismissBlocker,
  hasActiveBlocker,
  isStale,
  mayReAsk,
  resolveBlocker,
  signalsDue,
  type ProjectActor,
  type Task,
} from "../../src/domain/tasks/index.js";
import { githubSignalsAllowed } from "../../src/domain/github/index.js";

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

it("INV-13: порог C-1 — застой только после STALE_DAYS", () => {
  expect(isStale(constants.staleDays)).toBe(false);
  expect(isStale(constants.staleDays + 1)).toBe(true);
});

it("INV-13: переспрос не чаще RE_ASK_DAYS", () => {
  expect(mayReAsk(null)).toBe(true);
  expect(mayReAsk(constants.reAskDays - 1)).toBe(false);
  expect(mayReAsk(constants.reAskDays)).toBe(true);
});

it("INV-13: без GitHub сигналы CI/PR не ставятся", () => {
  expect(githubSignalsAllowed(null)).toBe(false);
  const due = signalsDue({
    daysWithoutCheck: constants.staleDays + 1,
    githubAvailable: false,
    github: {
      ciRed: true,
      prIdleDays: constants.staleDays + 1,
      issueIdleDays: constants.staleDays + 1,
      noBranchDays: constants.staleDays + 1,
    },
  });
  expect(due).toEqual(["no_check"]);
});

it("INV-13: GitHub доступен — сигналы застоя по порогу C-1", () => {
  const due = signalsDue({
    daysWithoutCheck: constants.staleDays + 1,
    githubAvailable: true,
    github: {
      ciRed: true,
      prIdleDays: constants.staleDays + 1,
      issueIdleDays: 0,
      noBranchDays: 0,
    },
  });
  expect(due).toContain("no_check");
  expect(due).toContain("ci_red");
  expect(due).toContain("pr_stale");
  expect(due).not.toContain("no_issue_activity");
});

it("INV-13: applyStaleSignals ставит BLOCKED и не дублирует сигнал", () => {
  const first = applyStaleSignals({
    task: inProgress(),
    blockers: [],
    signals: ["no_check"],
    blockerIdFor: () => "b-stale",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  expect(first.task.status).toBe("BLOCKED");
  expect(first.events).toHaveLength(1);
  const second = applyStaleSignals({
    task: first.task,
    blockers: first.blockers,
    signals: ["no_check"],
    blockerIdFor: () => "b-stale-2",
    detectedAt: "2026-09-21T00:00:00.000Z",
    detectedOnDate: "2026-09-21",
  });
  expect(second.events).toHaveLength(0);
  expect(second.blockers.filter((blocker) => blocker.active)).toHaveLength(1);
});
