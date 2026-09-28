import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  bindSupergroup,
  type BindResult,
  type Chat,
  type ChatBinding,
  type ChatStore,
  type ProjectChat,
  type SupergroupOffer,
} from '../domain/projects/chat.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function reportsTopicOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(asText(value, 'reports_topic_id'));
  if (!Number.isSafeInteger(parsed)) throw new Error('reports_topic_id повреждён');
  return parsed;
}

async function findUser(trx: Transaction<Database>, telegramUserId: string): Promise<User | null> {
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

function storeOf(trx: Transaction<Database>): ChatStore {
  return {
    async findProject(projectId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`project:${projectId}`})::bigint)`.execute(trx);
      const row = await trx
        .selectFrom('projects')
        .select(['id', 'timezone', 'chat_id'])
        .where('id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return null;
      const project: ProjectChat = {
        id: row.id,
        timezone: row.timezone,
        chatId: row.chat_id,
      };
      return project;
    },
    async findChatByTelegramId(telegramChatId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`chats:${telegramChatId}`})::bigint)`.execute(trx);
      const row = await trx
        .selectFrom('chats')
        .select(['id', 'telegram_chat_id', 'timezone', 'reports_topic_id', 'daily_cron'])
        .where('telegram_chat_id', '=', telegramChatId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const chat: Chat = {
        id: row.id,
        telegramChatId: asText(row.telegram_chat_id, 'telegram_chat_id'),
        timezone: row.timezone,
        reportsTopicId: reportsTopicOf(row.reports_topic_id),
        dailyCron: row.daily_cron,
      };
      return chat;
    },
    async insertChat(chat) {
      await trx
        .insertInto('chats')
        .values({
          id: chat.id,
          telegram_chat_id: chat.telegramChatId,
          timezone: chat.timezone,
          reports_topic_id: chat.reportsTopicId === null ? null : String(chat.reportsTopicId),
          daily_cron: chat.dailyCron,
        })
        .execute();
    },
    async setProjectChat(projectId, chatId) {
      await trx.updateTable('projects').set({ chat_id: chatId }).where('id', '=', projectId).execute();
    },
  };
}

/** Привязка супергруппы: строка `chats`, `projects.chat_id` и `project.chat_bound` коммитятся вместе. */
export function createChatBinding(db: Kysely<Database>, clock: Clock): ChatBinding {
  return {
    async unboundProjects() {
      const rows = await db
        .selectFrom('projects')
        .select(['id', 'name'])
        .where('chat_id', 'is', null)
        .orderBy('created_at')
        .execute();
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    async knownChats() {
      const rows = await db.selectFrom('chats').select(['telegram_chat_id']).orderBy('telegram_chat_id').execute();
      return rows.map((row) => ({ telegramChatId: asText(row.telegram_chat_id, 'telegram_chat_id') }));
    },
    async rootTelegramId() {
      const row = await db.selectFrom('users').select(['telegram_user_id']).where('is_root', '=', true).executeTakeFirst();
      if (row === undefined) return null;
      return asText(row.telegram_user_id, 'telegram_user_id');
    },
    confirm(input: {
      telegramUserId: string;
      projectId: string;
      offer: SupergroupOffer;
      idempotencyKey: string;
    }): Promise<BindResult> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return bindSupergroup(storeOf(trx), createEventJournal(trx), clock, {
          projectId: input.projectId,
          newChatId: randomUUID(),
          offer: input.offer,
          actor,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
