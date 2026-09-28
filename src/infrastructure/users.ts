import { sql, type Kysely, type Transaction } from 'kysely';
import { createRoot, type NewUser, type User, type UserStore } from '../domain/projects/user.ts';
import type { Database } from './database.ts';

function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  throw new Error('count пользователей не число');
}

function storeOf(trx: Transaction<Database>): UserStore {
  return {
    async countForUpdate() {
      await sql`SELECT pg_advisory_xact_lock(hashtext('users')::bigint)`.execute(trx);
      const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(trx);
      const row = result.rows[0];
      if (row === undefined) throw new Error('count без строки');
      return countOf(row.n);
    },
    async insert(user) {
      await trx
        .insertInto('users')
        .values({
          id: user.id,
          telegram_user_id: user.telegramUserId,
          name: user.name,
          is_root: user.isRoot,
        })
        .execute();
    },
  };
}

/** Создание корня: блокировка, проверка и вставка коммитятся вместе. */
export async function registerRoot(db: Kysely<Database>, input: NewUser): Promise<User> {
  return db.transaction().execute((trx) => createRoot(storeOf(trx), input));
}
