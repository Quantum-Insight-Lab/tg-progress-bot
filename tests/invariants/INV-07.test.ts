import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-07: пункт списка ссылается на задачу того же проекта", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  const foreignTask = await insertTask(pool, other);
  const listId = randomUUID();
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [listId, home.projectId, "2026-09-22"],
  );
  await expect(
    pool.query(
      `INSERT INTO task_list_items (id, project_id, list_id, task_id, position, is_done)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), home.projectId, listId, foreignTask, 0, false],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23503");
});
