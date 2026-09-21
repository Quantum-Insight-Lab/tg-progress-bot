import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import { createTask, reassignTask } from "../../src/domain/tasks/index.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-02: задача без исполнителя не вставляется", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  await expect(
    pool.query(
      `INSERT INTO tasks (id, project_id, issue_id, assignee_id, title, status, priority)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
      [randomUUID(), seed.projectId, seed.issueId, "T", "IN_PROGRESS", "normal"],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23502");
});

it("INV-02: исполнитель должен быть участником проекта", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const stranger = await seedProject(pool);
  await expect(
    pool.query(
      `INSERT INTO tasks (id, project_id, issue_id, assignee_id, title, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        home.projectId,
        home.issueId,
        stranger.userId,
        "T",
        "IN_PROGRESS",
        "normal",
      ],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23503");
});

it("INV-02: задача без исполнителя-участника не создаётся", () => {
  const base = {
    id: "task-1",
    projectId: "proj-1",
    issueId: "issue-1",
    title: "Шаг",
    createdByUserId: "u-lead",
    target: "today" as const,
    issue: { id: "issue-1", projectId: "proj-1" },
    actor: { userId: "u-lead", role: "lead" as const },
    idempotencyKey: "cb-1",
  };
  try {
    createTask({
      ...base,
      assigneeId: "stranger",
      assignee: undefined,
    });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("not_a_member");
  }
});

it("INV-02: переназначение только на участника проекта", () => {
  const task = createTask({
    id: "task-1",
    projectId: "proj-1",
    issueId: "issue-1",
    assigneeId: "u-assignee",
    title: "Шаг",
    createdByUserId: "u-lead",
    target: "today",
    issue: { id: "issue-1", projectId: "proj-1" },
    assignee: { projectId: "proj-1", userId: "u-assignee" },
    actor: { userId: "u-lead", role: "lead" },
    idempotencyKey: "cb-1",
  }).task;
  expect(() =>
    reassignTask({
      task,
      assigneeId: "stranger",
      assignee: undefined,
      actor: { userId: "u-lead", role: "lead" },
      idempotencyKey: "cb-2",
    }),
  ).toThrow(DomainError);
});
