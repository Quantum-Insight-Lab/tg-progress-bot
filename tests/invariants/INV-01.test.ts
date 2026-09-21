import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  createTask,
  pickIssueFromMirror,
  requireIssuesInMirror,
} from "../../src/domain/tasks/index.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-01: задача без issue не вставляется", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  await expect(
    pool.query(
      `INSERT INTO tasks (id, project_id, issue_id, assignee_id, title, status, priority)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [randomUUID(), seed.projectId, seed.userId, "T", "IN_PROGRESS", "normal"],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23502");
});

it("INV-01: задача не ссылается на issue другого проекта", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  await expect(
    pool.query(
      `INSERT INTO tasks (id, project_id, issue_id, assignee_id, title, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        home.projectId,
        other.issueId,
        home.userId,
        "T",
        "IN_PROGRESS",
        "normal",
      ],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23503");
});

it("INV-01: задача с issue своего проекта вставляется", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  await expect(insertTask(pool, seed)).resolves.toBeTypeOf("string");
});

it("INV-01: задача без issue своего проекта не создаётся", () => {
  const draft = {
    id: "task-1",
    projectId: "proj-1",
    issueId: "issue-1",
    assigneeId: "u-assignee",
    title: "Шаг",
    createdByUserId: "u-author",
    target: "today" as const,
    assignee: { projectId: "proj-1", userId: "u-assignee" },
    actor: { userId: "u-author", role: "member" as const },
    idempotencyKey: "cb-1",
  };
  try {
    createTask({ ...draft, issue: undefined });
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_transition");
  }
  expect(() =>
    createTask({ ...draft, issue: { id: "issue-1", projectId: "other" } }),
  ).toThrow(DomainError);
});

it("INV-01: пустое зеркало и чужой проект отклоняются", () => {
  try {
    requireIssuesInMirror([], "proj-1");
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_transition");
  }
  expect(() =>
    pickIssueFromMirror(
      [{ id: "issue-1", projectId: "other" }],
      "proj-1",
      "issue-1",
    ),
  ).toThrow(DomainError);
  expect(
    pickIssueFromMirror(
      [{ id: "issue-1", projectId: "proj-1" }],
      "proj-1",
      "issue-1",
    ),
  ).toEqual({ id: "issue-1", projectId: "proj-1" });
});
