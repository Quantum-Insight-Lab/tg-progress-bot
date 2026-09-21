import { expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import {
  progressOfAllProjectsForReport,
  progressOfProject,
  takeProgressSnapshot,
  type ProgressTask,
} from "../../src/domain/progress/index.js";
import { createClock } from "../../src/infrastructure/clock.js";

const home = "proj-home";
const other = "proj-other";

function task(
  projectId: string,
  status: ProgressTask["status"],
  priority: ProgressTask["priority"] = "normal",
): ProgressTask {
  return { projectId, status, priority };
}

it("INV-10: прогресс считается только по задачам своего проекта", () => {
  const tasks = [
    task(home, "DONE", "high"),
    task(home, "IN_PROGRESS", "low"),
    task(other, "DONE", "high"),
  ];
  const homeWeight =
    constants.priorityWeights.high + constants.priorityWeights.low;
  expect(progressOfProject(home, tasks)).toBe(
    constants.priorityWeights.high / homeWeight,
  );
  expect(progressOfProject(other, tasks)).toBe(1);
});

it("INV-10: CANCELLED не входит в знаменатель, вес из приоритета", () => {
  const tasks = [
    task(home, "DONE", "high"),
    task(home, "CANCELLED", "high"),
    task(home, "PLANNED", "normal"),
  ];
  const denom =
    constants.priorityWeights.high + constants.priorityWeights.normal;
  expect(progressOfProject(home, tasks)).toBe(
    constants.priorityWeights.high / denom,
  );
});

it("INV-10: общий процент для отчётов — не сумма процентов проектов", () => {
  const tasks = [
    task(home, "DONE", "normal"),
    task(other, "IN_PROGRESS", "normal"),
  ];
  expect(progressOfProject(home, tasks)).toBe(1);
  expect(progressOfProject(other, tasks)).toBe(0);
  expect(progressOfAllProjectsForReport(tasks)).toBe(
    constants.priorityWeights.normal /
      (constants.priorityWeights.normal + constants.priorityWeights.normal),
  );
});

it("INV-10: снимок берёт дату по таймзоне проекта", () => {
  const clock = createClock({
    current: () => new Date("2026-09-20T17:00:00.000Z"),
  });
  const timeZone = "Asia/Bangkok";
  const taken = takeProgressSnapshot({
    id: "snap-1",
    projectId: home,
    tasks: [task(home, "DONE"), task(other, "IN_PROGRESS")],
    snapshotDate: clock.calendarDate(timeZone),
    createdAt: clock.now(timeZone).iso,
  });
  expect(taken.snapshot.snapshotDate).toBe("2026-09-21");
  expect(taken.snapshot.progress).toBe(1);
  expect(taken.snapshot.tasksTotal).toBe(1);
  expect(taken.snapshot.tasksDone).toBe(1);
  expect(taken.event.idempotencyKey).toBe(`${home}:2026-09-21`);
  expect(taken.event.payload.project_id).toBe(home);
});
