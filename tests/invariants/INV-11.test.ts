import { expect, it } from "vitest";
import {
  dynamicsSeries,
  formatProgress,
  NO_PROGRESS_LABEL,
  progressOfProject,
  takeProgressSnapshot,
  type ProgressTask,
} from "../../src/domain/progress/index.js";

const projectId = "proj-1";

function task(status: ProgressTask["status"]): ProgressTask {
  return { projectId, status, priority: "normal" };
}

it("INV-11: пустой знаменатель даёт null, не процент", () => {
  expect(progressOfProject(projectId, [])).toBeNull();
  expect(progressOfProject(projectId, [task("CANCELLED")])).toBeNull();
  expect(formatProgress(null)).toBe(NO_PROGRESS_LABEL);
  expect(formatProgress(progressOfProject(projectId, []))).toBe("Нет данных");
});

it("INV-11: при задачах 0 — не «Нет данных»", () => {
  expect(progressOfProject(projectId, [task("IN_PROGRESS")])).toBe(0);
  expect(formatProgress(0)).not.toBe(NO_PROGRESS_LABEL);
});

it("INV-11: в динамике пропуски не заполняются", () => {
  const series = dynamicsSeries([
    { snapshotDate: "2026-09-21", progress: 0.5 },
    { snapshotDate: "2026-09-19", progress: 0 },
  ]);
  expect(series.map((point) => point.snapshotDate)).toEqual([
    "2026-09-19",
    "2026-09-21",
  ]);
  expect(series).toHaveLength(2);
});

it("INV-11: снимок пустого проекта хранит null, не 0", () => {
  const taken = takeProgressSnapshot({
    id: "snap-empty",
    projectId,
    tasks: [],
    snapshotDate: "2026-09-21",
    createdAt: "2026-09-21T00:00:00.000Z",
  });
  expect(taken.snapshot.progress).toBeNull();
  expect(taken.event.payload.progress).toBeNull();
  expect(formatProgress(taken.snapshot.progress)).toBe("Нет данных");
});
