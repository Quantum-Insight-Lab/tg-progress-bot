/**
 * Применяет SQL-файлы из migrations/ по порядку.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "../src/infrastructure/db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");

export async function applyMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of files) {
    const already = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [name],
    );
    if ((already.rowCount ?? 0) > 0) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    await pool.query(sql);
    await pool.query(
      "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING",
      [name],
    );
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  applyMigrations()
    .then(() => closePool())
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
