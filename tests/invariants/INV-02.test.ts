import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
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
