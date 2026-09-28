import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import {
  changeProjectSetting,
  showProjectSettings,
  type ProjectSettings,
  type SettingsMember,
  type SettingsStore,
  type StoredProject,
} from '../domain/projects/settings.ts';
import type { ProjectRole } from '../domain/projects/member.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function time(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
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

function projectOf(row: {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chat_id: string | null;
  created_at: Date | string;
}): StoredProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    chatId: row.chat_id,
    createdAt: time(row.created_at),
  };
}

function storeOf(trx: Transaction<Database>): SettingsStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`settings:${name}`})::bigint)`.execute(trx);
      const rows = await trx
        .selectFrom('projects')
        .select(['id', 'name', 'description', 'timezone', 'chat_id', 'created_at'])
        .where('name', '=', name)
        .orderBy('id')
        .forUpdate()
        .execute();
      return rows.map((row) => projectOf(row));
    },
    async findProject(projectId) {
      const row = await trx
        .selectFrom('projects')
        .select(['id', 'name', 'description', 'timezone', 'chat_id', 'created_at'])
        .where('id', '=', projectId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return projectOf(row);
    },
    async members(projectId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .select(['project_members.id', 'project_members.user_id', 'project_members.role', 'users.name'])
        .orderBy('users.name')
        .orderBy('project_members.id')
        .execute();
      return rows.map((row) => memberOf(row));
    },
    async membersNamed(projectId, name) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .where('users.name', '=', name)
        .select(['project_members.id', 'project_members.user_id', 'project_members.role', 'users.name'])
        .orderBy('project_members.id')
        .execute();
      return rows.map((row) => memberOf(row));
    },
    async findChatByTelegramId(telegramChatId) {
      const row = await trx
        .selectFrom('chats')
        .select(['id', 'telegram_chat_id'])
        .where('telegram_chat_id', '=', telegramChatId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { id: row.id, telegramChatId: asText(row.telegram_chat_id, 'telegram_chat_id') };
    },
    async chatTelegramId(chatId) {
      const row = await trx.selectFrom('chats').select(['telegram_chat_id']).where('id', '=', chatId).executeTakeFirst();
      if (row === undefined) return null;
      return asText(row.telegram_chat_id, 'telegram_chat_id');
    },
    async saveName(projectId, name) {
      await trx.updateTable('projects').set({ name }).where('id', '=', projectId).execute();
    },
    async saveDescription(projectId, description) {
      await trx.updateTable('projects').set({ description }).where('id', '=', projectId).execute();
    },
    async saveTimezone(projectId, timezone) {
      await trx.updateTable('projects').set({ timezone }).where('id', '=', projectId).execute();
    },
    async saveChat(projectId, chatId) {
      await trx.updateTable('projects').set({ chat_id: chatId }).where('id', '=', projectId).execute();
    },
    async saveRole(memberId, role) {
      await trx.updateTable('project_members').set({ role }).where('id', '=', memberId).execute();
    },
  };
}

function memberOf(row: { id: string; user_id: string; role: ProjectRole; name: string }): SettingsMember {
  return { id: row.id, userId: row.user_id, name: row.name, role: row.role };
}

/** Настройки проекта: правка поля и `project.settings_changed` коммитятся одной транзакцией. */
export function createProjectSettings(db: Kysely<Database>, clock: Clock): ProjectSettings {
  return {
    open(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return showProjectSettings(storeOf(trx), {
          actor,
          projectName: input.projectName,
          chat: input.chat,
        });
      });
    },
    change(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return changeProjectSetting(storeOf(trx), createEventJournal(trx), clock, {
          actor,
          projectName: input.projectName,
          chat: input.chat,
          update: input.update,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
