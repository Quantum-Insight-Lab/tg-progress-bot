import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
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
