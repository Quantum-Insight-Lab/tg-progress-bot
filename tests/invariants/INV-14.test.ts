import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-14: у задачи не больше одного незакрытого пункта", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const taskId = await insertTask(pool, seed);
  const listA = randomUUID();
  const listB = randomUUID();
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [listA, seed.projectId, "2026-09-23"],
  );
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [listB, seed.projectId, "2026-09-24"],
  );
  await pool.query(
    `INSERT INTO task_list_items (id, project_id, list_id, task_id, position, is_done)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), seed.projectId, listA, taskId, 0, false],
  );
  await expect(
    pool.query(
      `INSERT INTO task_list_items (id, project_id, list_id, task_id, position, is_done)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), seed.projectId, listB, taskId, 0, false],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23505");
});

it("INV-14: закрытый пункт не мешает новому незакрытому", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const taskId = await insertTask(pool, seed);
  const listA = randomUUID();
  const listB = randomUUID();
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [listA, seed.projectId, "2026-09-25"],
  );
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [listB, seed.projectId, "2026-09-26"],
  );
  await pool.query(
    `INSERT INTO task_list_items (id, project_id, list_id, task_id, position, is_done)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), seed.projectId, listA, taskId, 0, true],
  );
  await expect(
    pool.query(
      `INSERT INTO task_list_items (id, project_id, list_id, task_id, position, is_done)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), seed.projectId, listB, taskId, 0, false],
    ),
  ).resolves.toBeTruthy();
});
