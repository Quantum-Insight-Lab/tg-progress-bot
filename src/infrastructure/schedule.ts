import { sql, type Kysely, type Transaction } from 'kysely';
import {
  clearChatSchedule,
  describeSchedule,
  setChatSchedule,
  type ScheduleActions,
  type ScheduleOutcome,
  type ScheduleProject,
  type ScheduleStore,
} from '../domain/projects/schedule.ts';
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

function storeOf(trx: Transaction<Database>): ScheduleStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      const rows = await trx
        .selectFrom('projects')
        .select(['id', 'name', 'timezone', 'chat_id'])
        .where('name', '=', name)
        .orderBy('id')
        .execute();
      const projects: ScheduleProject[] = [];
      for (const row of rows) {
        let chatTimezone: string | null = null;
        let dailyCron: string | null = null;
        if (row.chat_id !== null) {
          const chat = await trx
            .selectFrom('chats')
            .select(['timezone', 'daily_cron'])
            .where('id', '=', row.chat_id)
            .executeTakeFirst();
          if (chat !== undefined) {
            chatTimezone = chat.timezone;
            dailyCron = chat.daily_cron;
          }
        }
        projects.push({
          id: row.id,
          name: row.name,
          timezone: row.timezone,
          chatId: row.chat_id,
          chatTimezone,
          dailyCron,
        });
      }
      return projects;
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
    async lockChat(chatId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`schedule:${chatId}`})::bigint)`.execute(trx);
    },
    async readChat(chatId) {
      const row = await trx.selectFrom('chats').select(['timezone', 'daily_cron']).where('id', '=', chatId).executeTakeFirst();
      if (row === undefined) return null;
      return { timezone: row.timezone, dailyCron: row.daily_cron };
    },
    async saveSchedule(chatId, dailyTime, timezone) {
      await trx.updateTable('chats').set({ daily_cron: dailyTime, timezone }).where('id', '=', chatId).execute();
    },
    async clearTime(chatId) {
      await trx.updateTable('chats').set({ daily_cron: null }).where('id', '=', chatId).execute();
    },
  };
}

/** Расписание группы: `daily_cron`, таймзона чата и событие коммитятся одной транзакцией. */
export function createChatSchedule(db: Kysely<Database>, logger: Logger, clock: Clock): ScheduleActions {
  return {
    show(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return describeSchedule(storeOf(trx), { actor, projectName: input.projectName, chat: input.chat });
      });
    },
    set(input): Promise<ScheduleOutcome> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return setChatSchedule(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          chat: input.chat,
          projectName: input.projectName,
          dailyTime: input.dailyTime,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
    clear(input): Promise<ScheduleOutcome> {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return clearChatSchedule(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          chat: input.chat,
          projectName: input.projectName,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
