import { sql, type Kysely, type Transaction } from 'kysely';
import {
  changeProjectRepository,
  connectProjectRepository,
  describeProjectRepository,
  describeProjectRepositoryById,
  skipProjectRepository,
  type ChangedRepository,
  type ConnectedRepository,
  type KnownRepository,
  type ProjectLink,
  type ProjectRepositoryActions,
  type RepositoryStepView,
  type ProjectRepositoryStore,
  type SkipResult,
} from '../domain/projects/connect-repository.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function userOf(row: {
  id: string;
  telegram_user_id: string;
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

async function findUser(trx: Transaction<Database>, telegramUserId: string): Promise<User | null> {
  const row = await trx
    .selectFrom('users')
    .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
    .where('telegram_user_id', '=', telegramUserId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return userOf(row);
}

async function repositoryOf(trx: Transaction<Database>, repositoryId: string | null): Promise<KnownRepository | null> {
  if (repositoryId === null) return null;
  const row = await trx
    .selectFrom('repositories')
    .select(['id', 'owner', 'name'])
    .where('id', '=', repositoryId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return { id: row.id, owner: row.owner, name: row.name };
}

async function linkOf(
  trx: Transaction<Database>,
  row: { id: string; name: string; repository_id: string | null },
): Promise<ProjectLink> {
  return { id: row.id, name: row.name, repository: await repositoryOf(trx, row.repository_id) };
}

function storeOf(trx: Transaction<Database>): ProjectRepositoryStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      const rows = await trx
        .selectFrom('projects')
        .select(['id', 'name', 'repository_id'])
        .where('name', '=', name)
        .orderBy('id')
        .execute();
      const links: ProjectLink[] = [];
      for (const row of rows) links.push(await linkOf(trx, row));
      return links;
    },
    async findProject(projectId) {
      const row = await trx
        .selectFrom('projects')
        .select(['id', 'name', 'repository_id'])
        .where('id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return null;
      return linkOf(trx, row);
    },
    async roleOnProject(projectId, userId) {
      const row = await trx
        .selectFrom('project_members')
        .select(['role'])
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return row.role;
    },
    async findRepository(repositoryId) {
      return repositoryOf(trx, repositoryId);
    },
    async lockProject(projectId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`project-repository:${projectId}`})::bigint)`.execute(trx);
    },
    async setRepository(projectId, repositoryId) {
      await trx.updateTable('projects').set({ repository_id: repositoryId }).where('id', '=', projectId).execute();
    },
  };
}

/** Подключение репозитория: ссылка и `project.repository_connected` коммитятся одной транзакцией. */
export function createProjectRepository(db: Kysely<Database>, logger: Logger, clock: Clock): ProjectRepositoryActions {
  return {
    open(input): Promise<RepositoryStepView> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeProjectRepository(storeOf(trx), { actor, projectName: input.projectName, chat: input.chat });
      });
    },
    openById(input): Promise<RepositoryStepView> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeProjectRepositoryById(storeOf(trx), { actor, projectId: input.projectId, chat: input.chat });
      });
    },
    connect(input): Promise<ConnectedRepository> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return connectProjectRepository(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          chat: input.chat,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
    change(input): Promise<ChangedRepository> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return changeProjectRepository(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          chat: input.chat,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
    skip(input): Promise<SkipResult> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return skipProjectRepository(storeOf(trx), {
          actor,
          projectId: input.projectId,
          chat: input.chat,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
