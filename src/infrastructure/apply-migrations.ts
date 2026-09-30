import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationSql } from './db.ts';

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY
);
REVOKE ALL ON TABLE schema_migrations FROM PUBLIC;`;

/** Имена файлов `migrations/` по порядку номера. Служебная таблица шага в этот список не входит. */
export function listMigrationFiles(root = process.cwd()): readonly string[] {
  return readdirSync(join(root, 'migrations'))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
}

/**
 * Применяет ещё не записанные миграции. Повтор ничего не меняет.
 * Каждая миграция — своя транзакция: при ошибке имя в `schema_migrations` не попадает.
 */
export async function applyMigrations(sql: MigrationSql, root = process.cwd()): Promise<readonly string[]> {
  await sql.exec(BOOKKEEPING);
  const applied: string[] = [];
  for (const name of listMigrationFiles(root)) {
    const existing = await sql.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
    if (existing.length > 0) continue;
    const body = readFileSync(join(root, 'migrations', name), 'utf8');
    await sql.exec('BEGIN');
    try {
      await sql.exec(body);
      await sql.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await sql.exec('COMMIT');
    } catch (error) {
      await sql.exec('ROLLBACK');
      throw error;
    }
    applied.push(name);
  }
  return applied;
}
