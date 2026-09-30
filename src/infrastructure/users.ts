import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import {
  createRoot,
  registerOnStart as decideRegistration,
  type NewUser,
  type RegistrationStore,
  type User,
  type UserRegistration,
} from '../domain/projects/user.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  throw new Error('count пользователей не число');
}

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function storeOf(trx: Transaction<Database>): RegistrationStore {
  const store: RegistrationStore = {
    async countForUpdate() {
      await sql`SELECT pg_advisory_xact_lock(hashtext('users')::bigint)`.execute(trx);
      const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(trx);
      const row = result.rows[0];
      if (row === undefined) throw new Error('count без строки');
      return countOf(row.n);
    },
    async findByTelegramUserId(telegramUserId) {
      const row = await trx
        .selectFrom('users')
        .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
        .where('telegram_user_id', '=', telegramUserId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        id: row.id,
        telegramUserId: asText(row.telegram_user_id, 'telegram_user_id'),
        githubLogin: row.github_login,
        name: row.name,
        isRoot: row.is_root,
      };
    },
    async insert(user) {
      await trx
        .insertInto('users')
        .values({
          id: user.id,
          telegram_user_id: user.telegramUserId,
          github_login: user.githubLogin,
          name: user.name,
          is_root: user.isRoot,
        })
        .execute();
    },
  };
  return store;
}

/** Создание корня: блокировка, проверка и вставка коммитятся вместе. */
export async function registerRoot(db: Kysely<Database>, input: NewUser): Promise<User> {
  return db.transaction().execute((trx) => createRoot(storeOf(trx), input));
}

/** `/start`: пользователь и `user.registered` коммитятся одной транзакцией. */
export function createUserRegistration(db: Kysely<Database>, logger: Logger, clock: Clock): UserRegistration {
  return {
    registerOnStart(input) {
      return db.transaction().execute((trx) =>
        decideRegistration(storeOf(trx), createEventJournal(trx, logger), clock, {
          id: randomUUID(),
          telegramUserId: input.telegramUserId,
          name: input.name,
        }),
      );
    },
  };
}
