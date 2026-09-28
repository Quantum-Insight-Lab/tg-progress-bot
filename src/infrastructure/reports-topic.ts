import { sql, type Kysely, type Transaction } from 'kysely';
import {
  assignNamedReportsTopic,
  assignReportsTopic,
  claimNewReportsTopic,
  describeReportsPrompt,
  describeReportsTopic,
  type ReportsHome,
  type ReportsProject,
  type ReportsTopicActions,
  type ReportsTopicStore,
} from '../domain/projects/reports-topic.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function topicOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(asText(value, 'reports_topic_id'));
  if (!Number.isSafeInteger(parsed)) throw new Error('reports_topic_id повреждён');
  return parsed;
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

function projectOf(row: {
  id: string;
  name: string;
  chat_id: string | null;
  telegram_chat_id: string | null;
  reports_topic_id: string | null;
}): ReportsProject {
  return {
    id: row.id,
    name: row.name,
    chatId: row.chat_id,
    telegramChatId: row.telegram_chat_id === null ? null : asText(row.telegram_chat_id, 'telegram_chat_id'),
    reportsTopicId: topicOf(row.reports_topic_id),
  };
}

const projectColumns = [
  'projects.id',
  'projects.name',
  'projects.chat_id',
  'chats.telegram_chat_id',
  'chats.reports_topic_id',
] as const;

function storeOf(trx: Transaction<Database>): ReportsTopicStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      const rows = await trx
        .selectFrom('projects')
        .leftJoin('chats', 'chats.id', 'projects.chat_id')
        .select(projectColumns)
        .where('projects.name', '=', name)
        .orderBy('projects.id')
        .execute();
      return rows.map((row) => projectOf(row));
    },
    async findProject(projectId) {
      const row = await trx
        .selectFrom('projects')
        .leftJoin('chats', 'chats.id', 'projects.chat_id')
        .select(projectColumns)
        .where('projects.id', '=', projectId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return projectOf(row);
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
    async executorTopicIds(chatId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('projects', 'projects.id', 'project_members.project_id')
        .select(['project_members.topic_id'])
        .where('projects.chat_id', '=', chatId)
        .where('project_members.topic_id', 'is not', null)
        .execute();
      return rows.flatMap((row) => {
        const topicId = topicOf(row.topic_id);
        return topicId === null ? [] : [topicId];
      });
    },
    async lockChat(chatId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`reports:${chatId}`})::bigint)`.execute(trx);
    },
    async setReportsTopic(chatId, topicId) {
      await trx.updateTable('chats').set({ reports_topic_id: String(topicId) }).where('id', '=', chatId).execute();
    },
  };
}

/** Командный топик: строка `reports_topic_id` и `chat.reports_topic_set` коммитятся одной транзакцией. */
export function createReportsTopics(db: Kysely<Database>, clock: Clock): ReportsTopicActions {
  return {
    show(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeReportsTopic(storeOf(trx), { actor, projectName: input.projectName, chat: input.chat });
      });
    },
    prompt(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeReportsPrompt(storeOf(trx), { actor, chat: input.chat, projectId: input.projectId });
      });
    },
    planCreate(input) {
      return db.transaction().execute(async (trx) => {
        const key = input.idempotencyKey.trim();
        if (key.length === 0) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
        const duplicate = await trx.selectFrom('events').select('id').where('idempotency_key', '=', key).executeTakeFirst();
        if (duplicate !== undefined) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_DUPLICATE, 'chat.reports_topic_set уже записан');
        const actor = await findUser(trx, input.telegramUserId);
        return claimNewReportsTopic(storeOf(trx), { actor, chat: input.chat, projectId: input.projectId });
      });
    },
    assign(input): Promise<ReportsHome> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return assignReportsTopic(storeOf(trx), createEventJournal(trx), clock, {
          actor,
          chat: input.chat,
          projectId: input.projectId,
          topicId: input.topicId,
          created: input.created,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
    specify(input): Promise<ReportsHome> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return assignNamedReportsTopic(storeOf(trx), createEventJournal(trx), clock, {
          actor,
          chat: input.chat,
          projectName: input.projectName,
          topicId: input.topicId,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
