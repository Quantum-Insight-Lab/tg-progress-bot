import { sql, type Kysely, type Transaction } from 'kysely';
import {
  showInstallationRepositories,
  type InstallationAudience,
  type InstallationRepositories,
  type InstallationRepositorySource,
  type RepositoryStore,
} from '../domain/github/repository.ts';
import { LEAD_ROLE } from '../domain/projects/member.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { Database } from './database.ts';

function identityConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (error instanceof Error && error.message.includes('repositories_owner_name_unique')) return true;
  if ('cause' in error) return identityConflict(error.cause);
  return false;
}

function audienceOf(trx: Transaction<Database>): InstallationAudience {
  return {
    async viewer(telegramUserId) {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'is_root'])
        .where('telegram_user_id', '=', telegramUserId)
        .executeTakeFirst();
      if (user === undefined) return null;
      const lead = await trx
        .selectFrom('project_members')
        .select('id')
        .where('user_id', '=', user.id)
        .where('role', '=', LEAD_ROLE)
        .executeTakeFirst();
      return { isRoot: user.is_root, leadsProject: lead !== undefined };
    },
  };
}

function storeOf(trx: Transaction<Database>): RepositoryStore {
  return {
    async upsert(repository) {
      try {
        await trx
          .insertInto('repositories')
          .values({ id: repository.id, owner: repository.owner, name: repository.name })
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet({
              owner: repository.owner,
              name: repository.name,
            }),
          )
          .execute();
      } catch (error) {
        if (identityConflict(error)) {
          throw new DomainError(DOMAIN_ERROR.REPOSITORY_IDENTITY, 'owner и name уже принадлежат другому id');
        }
        throw error;
      }
    },
    async list() {
      const rows = await trx.selectFrom('repositories').select(['id', 'owner', 'name']).orderBy('owner').orderBy('name').execute();
      return rows.map((row) => ({ id: row.id, owner: row.owner, name: row.name }));
    },
  };
}

/** Запись зеркала и показ списка. Источник — GitHub App, не личный токен. */
export function createInstallationRepositories(
  db: Kysely<Database>,
  source: InstallationRepositorySource,
): InstallationRepositories {
  return {
    async show(input) {
      return db.transaction().execute((trx) => showInstallationRepositories(audienceOf(trx), source, storeOf(trx), input));
    },
  };
}

/** Сколько строк зеркала. Одна строка на id репозитория. */
export async function countRepositories(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM repositories`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}
