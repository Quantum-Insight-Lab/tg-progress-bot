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
