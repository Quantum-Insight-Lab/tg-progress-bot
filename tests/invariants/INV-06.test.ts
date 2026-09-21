import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-06: на пару проект + дата не больше одного списка", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const day = "2026-09-21";
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [randomUUID(), seed.projectId, day],
  );
  await expect(
    pool.query(
      `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
      [randomUUID(), seed.projectId, day],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23505");
});
