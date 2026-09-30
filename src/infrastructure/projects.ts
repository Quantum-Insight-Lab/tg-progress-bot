import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  createProject as decideCreate,
  type CreatedProject,
  type ProjectCreation,
  type ProjectDraft,
  type ProjectStore,
} from '../domain/projects/create-project.ts';
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

async function findCreator(trx: Transaction<Database>, telegramUserId: string): Promise<User | null> {
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
}

function storeOf(trx: Transaction<Database>): ProjectStore {
  return {
    async insert(project) {
      await trx
        .insertInto('projects')
        .values({
          id: project.id,
          name: project.name,
          description: project.description,
          timezone: project.timezone,
          chat_id: project.chatId,
          created_at: new Date(project.createdAt),
        })
        .execute();
    },
  };
}

/** «Новый проект»: строка `projects` и `project.created` коммитятся одной транзакцией. */
export function createProjectCreation(db: Kysely<Database>, logger: Logger, clock: Clock): ProjectCreation {
  return {
    create(input: ProjectDraft): Promise<CreatedProject> {
      return db.transaction().execute(async (trx) => {
        const creator = await findCreator(trx, input.telegramUserId);
        return decideCreate(storeOf(trx), createEventJournal(trx, logger), clock, {
          id: randomUUID(),
          name: input.name,
          description: input.description,
          timezone: input.timezone,
          chat: input.chat,
          idempotencyKey: input.idempotencyKey,
          creator,
        });
      });
    },
  };
}
