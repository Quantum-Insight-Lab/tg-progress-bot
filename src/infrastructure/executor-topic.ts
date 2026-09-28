import type { Kysely, Transaction } from 'kysely';
import {
  assignExecutorTopic,
  assignNamedExecutorTopic,
  claimNewExecutorTopic,
  describeExecutorTopics,
  describeTopicPrompt,
  type AssignedTopic,
  type ExecutorTopicActions,
  type ExecutorTopicStore,
  type TopicBoard,
  type TopicMember,
  type TopicProject,
} from '../domain/projects/executor-topic.ts';
import type { ProjectRole } from '../domain/projects/member.ts';
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
  const text = asText(value, 'topic_id');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error('topic_id повреждён');
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
}): TopicProject {
  return {
    id: row.id,
    name: row.name,
    chatId: row.chat_id,
    telegramChatId: row.telegram_chat_id === null ? null : asText(row.telegram_chat_id, 'telegram_chat_id'),
  };
}

function memberOf(row: {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  name: string;
  telegram_user_id: string;
  github_login: string | null;
  topic_id: string | null;
}): TopicMember {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    name: row.name,
    telegramUserId: asText(row.telegram_user_id, 'telegram_user_id'),
    githubLogin: row.github_login,
    topicId: topicOf(row.topic_id),
  };
}

const memberColumns = [
  'project_members.id',
  'project_members.project_id',
  'project_members.user_id',
  'project_members.role',
  'project_members.topic_id',
  'users.name',
  'users.telegram_user_id',
  'users.github_login',
] as const;

function storeOf(trx: Transaction<Database>): ExecutorTopicStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      const rows = await trx
        .selectFrom('projects')
        .leftJoin('chats', 'chats.id', 'projects.chat_id')
        .select(['projects.id', 'projects.name', 'projects.chat_id', 'chats.telegram_chat_id'])
        .where('projects.name', '=', name)
        .orderBy('projects.id')
        .execute();
      return rows.map((row) => projectOf(row));
    },
    async findProject(projectId) {
      const row = await trx
        .selectFrom('projects')
        .leftJoin('chats', 'chats.id', 'projects.chat_id')
        .select(['projects.id', 'projects.name', 'projects.chat_id', 'chats.telegram_chat_id'])
        .where('projects.id', '=', projectId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return projectOf(row);
    },
    async members(projectId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .select(memberColumns)
        .orderBy('users.name')
        .orderBy('project_members.id')
        .execute();
      return rows.map((row) => memberOf(row));
    },
    async findMember(projectId, userId) {
      const row = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .where('project_members.user_id', '=', userId)
        .select(memberColumns)
        .executeTakeFirst();
      if (row === undefined) return null;
      return memberOf(row);
    },
    async findMembersByName(projectId, name) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .where('users.name', '=', name)
        .select(memberColumns)
        .orderBy('project_members.id')
        .execute();
      return rows.map((row) => memberOf(row));
    },
    async setTopic(memberId, topicId) {
      await trx.updateTable('project_members').set({ topic_id: String(topicId) }).where('id', '=', memberId).execute();
    },
    async reportsTopicId(projectId) {
      const row = await trx
        .selectFrom('projects')
        .leftJoin('chats', 'chats.id', 'projects.chat_id')
        .select(['chats.reports_topic_id'])
        .where('projects.id', '=', projectId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return topicOf(row.reports_topic_id);
    },
  };
}

/** Топик исполнителя: строка `topic_id` и `member.topic_set` коммитятся одной транзакцией. */
export function createExecutorTopics(db: Kysely<Database>, clock: Clock): ExecutorTopicActions {
  return {
    show(input): Promise<TopicBoard> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeExecutorTopics(storeOf(trx), { actor, projectName: input.projectName, chat: input.chat });
      });
    },
    prompt(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        return describeTopicPrompt(storeOf(trx), { actor, chat: input.chat, projectId: input.projectId, target });
      });
    },
    planCreate(input) {
      return db.transaction().execute(async (trx) => {
        const key = input.idempotencyKey.trim();
        if (key.length === 0) throw new DomainError(DOMAIN_ERROR.TOPIC_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
        const duplicate = await trx.selectFrom('events').select('id').where('idempotency_key', '=', key).executeTakeFirst();
        if (duplicate !== undefined) throw new DomainError(DOMAIN_ERROR.TOPIC_DUPLICATE, 'member.topic_set уже записан');
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        return claimNewExecutorTopic(storeOf(trx), { actor, chat: input.chat, projectId: input.projectId, target });
      });
    },
    assign(input): Promise<AssignedTopic> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        return assignExecutorTopic(storeOf(trx), createEventJournal(trx), clock, {
          actor,
          chat: input.chat,
          projectId: input.projectId,
          target,
          topicId: input.topicId,
          created: input.created,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
    specify(input): Promise<AssignedTopic> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return assignNamedExecutorTopic(storeOf(trx), createEventJournal(trx), clock, {
          actor,
          chat: input.chat,
          projectName: input.projectName,
          memberName: input.memberName,
          topicId: input.topicId,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
