import { sql, type Kysely, type Transaction } from 'kysely';
import {
  assertGithubLoginAvailable,
  setOwnGithubLogin,
  type GithubLoginActions,
  type GithubLoginStore,
  withCurrentGithubLogin,
} from '../domain/projects/github-login.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function userOf(row: {
  id: string;
  telegram_user_id: unknown;
  github_login: string | null;
  name: string;
  is_root: boolean;
}): User {
  return {
    id: row.id,
    telegramUserId: asText(row.telegram_user_id, 'telegram_user_id'),
    githubLogin: row.github_login,
    name: row.name,
    isRoot: row.is_root,
  };
}

function takenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (error instanceof Error && error.message.includes('users_github_login_unique')) return true;
  if ('cause' in error) return takenError(error.cause);
  return false;
}

async function findByTelegram(trx: Transaction<Database>, telegramUserId: string): Promise<User | null> {
  const row = await trx
    .selectFrom('users')
    .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
    .where('telegram_user_id', '=', telegramUserId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return null;
  return userOf(row);
}

async function findUser(trx: Transaction<Database>, userId: string): Promise<User | null> {
  const row = await trx
    .selectFrom('users')
    .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return null;
  return userOf(row);
}

async function ownerId(trx: Transaction<Database>, login: string): Promise<string | null> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM users
    WHERE github_login IS NOT NULL AND lower(github_login) = lower(${login})
    FOR UPDATE
  `.execute(trx);
  const row = result.rows[0];
  return row === undefined ? null : row.id;
}

/** Записать текущий логин. Пустая строка очищает поле. Занятый логин не переходит к другому. */
export async function recordGithubLogin(db: Kysely<Database>, userId: string, login: string | null): Promise<User> {
  return db.transaction().execute(async (trx) => {
    const user = await findUser(trx, userId);
    if (user === null) throw new DomainError(DOMAIN_ERROR.USER_NOT_FOUND, 'Пользователь не найден');
    const updated = withCurrentGithubLogin(user, login);
    if (updated.githubLogin !== null) {
      assertGithubLoginAvailable(await ownerId(trx, updated.githubLogin), user.id);
    }
    await writeLogin(trx, user.id, updated.githubLogin);
    return updated;
  });
}

async function writeLogin(trx: Transaction<Database>, userId: string, login: string | null): Promise<void> {
  try {
    await trx.updateTable('users').set({ github_login: login }).where('id', '=', userId).execute();
  } catch (error) {
    if (takenError(error)) {
      throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_TAKEN, 'Один логин GitHub принадлежит одному пользователю бота');
    }
    throw error;
  }
}

function storeOf(trx: Transaction<Database>): GithubLoginStore {
  return {
    ownerId(login) {
      return ownerId(trx, login);
    },
    save(userId, login) {
      return writeLogin(trx, userId, login);
    },
  };
}

/** Свой логин GitHub: поле и `user.github_login_set` коммитятся одной транзакцией. */
export function createGithubLogin(db: Kysely<Database>, logger: Logger, clock: Clock): GithubLoginActions {
  return {
    async find(telegramUserId) {
      const row = await db
        .selectFrom('users')
        .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
        .where('telegram_user_id', '=', telegramUserId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return userOf(row);
    },
    set(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findByTelegram(trx, input.telegramUserId);
        if (actor === null) throw new DomainError(DOMAIN_ERROR.USER_NOT_FOUND, 'Пользователь не найден');
        return setOwnGithubLogin(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          userId: actor.id,
          chat: input.chat,
          login: input.login,
          skip: input.skip,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
