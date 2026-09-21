import { beforeAll, expect, it } from "vitest";
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
