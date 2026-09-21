import { beforeAll, expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import { createTask, weightOf } from "../../src/domain/tasks/index.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-15: поля weight в схеме задач нет", async () => {
  const pool = getPool();
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'weight'`,
  );
  expect(result.rows).toEqual([]);
});

it("INV-15: вес — функция приоритета и в задаче не хранится", () => {
  expect(weightOf("high")).toBe(constants.priorityWeights.high);
  expect(weightOf("normal")).toBe(constants.priorityWeights.normal);
  expect(weightOf("low")).toBe(constants.priorityWeights.low);
  const { task } = createTask({
    id: "task-1",
    projectId: "proj-1",
    issueId: "issue-1",
    assigneeId: "u-a",
    title: "Шаг",
    createdByUserId: "u-a",
    target: "today",
    issue: { id: "issue-1", projectId: "proj-1" },
    assignee: { projectId: "proj-1", userId: "u-a" },
    actor: { userId: "u-a", role: "member" },
    idempotencyKey: "cb-1",
  });
  expect(task).not.toHaveProperty("weight");
  expect(task.priority).toBe(constants.defaultPriority);
});
