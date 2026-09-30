import { CompiledQuery, Kysely, PostgresDialect, type DatabaseConnection } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './database.ts';

/** Роль миграции: INSERT и SELECT, без UPDATE и DELETE (INV-28). */
export const JOURNAL_ROLE = 'journal_app';

let pool: Kysely<Database> | undefined;

/** Соединение журнала работает от роли без правки и удаления. */
export async function assumeJournalRole(connection: DatabaseConnection): Promise<void> {
  await connection.executeQuery(CompiledQuery.raw(`SET ROLE ${JOURNAL_ROLE}`));
}

/** Соединение шага миграций: тот же модуль пула, без роли журнала. DDL через `getDb` не проходит. */
export interface MigrationSql {
  exec(sql: string): Promise<void>;
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

function records(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) record[key] = value;
    return record;
  });
}

/**
 * Соединение для отдельного шага миграций. Не пул процесса: роль `journal_app` не выполняет DDL.
 * Пул создаётся здесь и закрывается до возврата.
 */
export async function withMigrationSql<T>(connectionString: string, run: (sql: MigrationSql) => Promise<T>): Promise<T> {
  if (connectionString.length === 0) throw new Error('DATABASE_URL не задан');
  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      const sql: MigrationSql = {
        async exec(text) {
          await client.query(text);
        },
        async query(text, params = []) {
          const result = await client.query(text, [...params]);
          return records(result.rows);
        },
      };
      return await run(sql);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Единственный пул процесса (B-14). Повторный вызов возвращает тот же экземпляр. */
export function getDb(connectionString = process.env.DATABASE_URL): Kysely<Database> {
  if (pool) return pool;
  if (connectionString === undefined || connectionString.length === 0) throw new Error('DATABASE_URL не задан');
  pool = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString }),
      onCreateConnection: assumeJournalRole,
    }),
  });
  return pool;
}
