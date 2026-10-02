import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  assessSupergroup,
  canvasAndReportTarget,
  defineChat,
  defineDailyCron,
  defineReportsTopicId,
  type SupergroupOffer,
} from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { ACCESS_DENIED_REPLY } from '../src/telegram/access-guard.ts';
import { SUPERGROUP_BOUND, SUPERGROUP_REQUEST, SUPERGROUP_SHARED } from '../src/telegram/chat-binding.ts';
import { PROJECT_REPOSITORY_HEADING } from '../src/telegram/connect-repository.ts';
import { NEW_PROJECT_HEADING } from '../src/telegram/new-project.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const secondAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const telegramChatId = '-1001234567890';

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

function env(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    PORT: '0',
    SCHEDULER_INTERVAL_MS: '60000',
  };
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function registerRoot(db: Kysely<Database>): Promise<string> {
  const registration = createUserRegistration(db, silentLogger, clock);
  const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  return root.user.id;
}

async function registerSecond(db: Kysely<Database>): Promise<void> {
  const registration = createUserRegistration(db, silentLogger, clock);
  await registration.registerOnStart({ telegramUserId: String(secondAccount.id), name: secondAccount.first_name });
}

async function createNamed(
  db: Kysely<Database>,
  name: string,
  timezone: string,
  idempotencyKey: string,
): Promise<string> {
  const created = await createProjectCreation(db, silentLogger, clock).create({
    telegramUserId: String(rootAccount.id),
    name,
    description: '',
    timezone,
    chat: 'private',
    idempotencyKey,
  });
  return created.project.id;
}

async function countChats(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM chats`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

async function chatEvents(db: Kysely<Database>): Promise<{ idempotencyKey: string; payload: unknown }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown }>`
    SELECT idempotency_key, payload FROM events WHERE event_type = ${EVENT_TYPES.PROJECT_CHAT_BOUND} ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

describe('E-2 группа — таблица chats', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('E-2 поля группы: id, telegram_chat_id, timezone', async () => {
    const chat = defineChat({ id: '00000000-0000-4000-8000-0000000000aa', telegramChatId, timezone: ' Europe/Moscow ' });
    expect(chat.timezone).toBe('Europe/Moscow');
    expect(chat.telegramChatId).toBe(telegramChatId);

    const handle = await openDb();
    opened.push(handle);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chats'
      ORDER BY column_name
    `.execute(handle.db);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'daily_cron',
      'id',
      'reports_topic_id',
      'telegram_chat_id',
      'timezone',
    ]);
    await sql`
      INSERT INTO chats (id, telegram_chat_id, timezone)
      VALUES (${chat.id}::uuid, ${chat.telegramChatId}::bigint, ${chat.timezone})
    `.execute(handle.db);
    const stored = await sql<{ telegram_chat_id: string; timezone: string }>`
      SELECT telegram_chat_id::text AS telegram_chat_id, timezone FROM chats
    `.execute(handle.db);
    expect(stored.rows).toEqual([{ telegram_chat_id: telegramChatId, timezone: 'Europe/Moscow' }]);
  });

  it('E-2 топик и пустая таймзона не записываются, telegram_chat_id уникален', async () => {
    expect(() => defineChat({ id: ' ', telegramChatId, timezone: 'UTC' })).toThrow(DomainError);
    expect(() => defineChat({ id: '00000000-0000-4000-8000-0000000000aa', telegramChatId: '15', timezone: 'UTC' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CHAT_IS_TOPIC }),
    );
    expect(() => defineChat({ id: '00000000-0000-4000-8000-0000000000aa', telegramChatId, timezone: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CHAT_TIMEZONE_BLANK }),
    );
    expect(assessSupergroup({ ...forumAdmin, kind: 'topic' })?.code).toBe(DOMAIN_ERROR.CHAT_IS_TOPIC);
    expect(assessSupergroup({ ...forumAdmin, forum: false })?.code).toBe(DOMAIN_ERROR.CHAT_NOT_SUPERGROUP);
    expect(assessSupergroup({ ...forumAdmin, canManageTopics: false })?.code).toBe(DOMAIN_ERROR.CHAT_ADMIN_RIGHTS);
    expect(assessSupergroup({ ...forumAdmin, canPostMessages: false })?.code).toBe(DOMAIN_ERROR.CHAT_ADMIN_RIGHTS);
    expect(assessSupergroup(forumAdmin)).toBeNull();

    const handle = await openDb();
    opened.push(handle);
    const id = '00000000-0000-4000-8000-0000000000aa';
    await expect(
      sql`
        INSERT INTO chats (id, telegram_chat_id, timezone)
        VALUES (${id}::uuid, ${'15'}::bigint, 'UTC')
      `.execute(handle.db),
    ).rejects.toThrow(/chats_telegram_chat_id_supergroup|23514/);
    await expect(
      sql`
        INSERT INTO chats (id, telegram_chat_id, timezone)
        VALUES (${id}::uuid, ${telegramChatId}::bigint, ' ')
      `.execute(handle.db),
    ).rejects.toThrow(/chats_timezone_not_blank|23514/);
    await sql`
      INSERT INTO chats (id, telegram_chat_id, timezone)
      VALUES (${id}::uuid, ${telegramChatId}::bigint, 'UTC')
    `.execute(handle.db);
    await expect(
      sql`
        INSERT INTO chats (id, telegram_chat_id, timezone)
        VALUES ('00000000-0000-4000-8000-0000000000bb'::uuid, ${telegramChatId}::bigint, 'UTC')
      `.execute(handle.db),
    ).rejects.toThrow(/chats_telegram_chat_id_unique|23505/);
    expect(await countChats(handle.db)).toBe(1);
  });
});

describe('E-2 командный топик и время — поля chats', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('E-2 reports_topic_id пуст, пока не выбран; ноль и отрицательный номер не пишутся', async () => {
    expect(defineReportsTopicId(null)).toBeNull();
    expect(defineReportsTopicId(7)).toBe(7);
    expect(() => defineReportsTopicId(0)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.REPORTS_TOPIC_ID }));
    expect(() => defineReportsTopicId(-1)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.REPORTS_TOPIC_ID }));
    expect(() => defineReportsTopicId(1.5)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.REPORTS_TOPIC_ID }));

    const handle = await openDb();
    opened.push(handle);
    const id = '00000000-0000-4000-8000-0000000000aa';
    await sql`
      INSERT INTO chats (id, telegram_chat_id, timezone)
      VALUES (${id}::uuid, ${telegramChatId}::bigint, 'UTC')
    `.execute(handle.db);
    const empty = await sql<{ reports_topic_id: string | null }>`
      SELECT reports_topic_id::text AS reports_topic_id FROM chats
    `.execute(handle.db);
    expect(empty.rows).toEqual([{ reports_topic_id: null }]);
    await expect(
      sql`UPDATE chats SET reports_topic_id = 0`.execute(handle.db),
    ).rejects.toThrow(/chats_reports_topic_id_positive|23514/);
    await expect(
      sql`UPDATE chats SET reports_topic_id = -3`.execute(handle.db),
    ).rejects.toThrow(/chats_reports_topic_id_positive|23514/);
    await sql`UPDATE chats SET reports_topic_id = 42`.execute(handle.db);
    const stored = await sql<{ reports_topic_id: string }>`
      SELECT reports_topic_id::text AS reports_topic_id FROM chats
    `.execute(handle.db);
    expect(stored.rows).toEqual([{ reports_topic_id: '42' }]);
  });

  it('E-2 daily_cron живёт на чате: пусто допустимо, пустая строка нет', async () => {
    expect(defineDailyCron(null)).toBeNull();
    expect(defineDailyCron('   ')).toBeNull();
    expect(defineDailyCron(' 09:00 ')).toBe('09:00');

    const handle = await openDb();
    opened.push(handle);
    const id = '00000000-0000-4000-8000-0000000000aa';
    await sql`
      INSERT INTO chats (id, telegram_chat_id, timezone, daily_cron)
      VALUES (${id}::uuid, ${telegramChatId}::bigint, 'UTC', NULL)
    `.execute(handle.db);
    const empty = await sql<{ daily_cron: string | null }>`SELECT daily_cron FROM chats`.execute(handle.db);
    expect(empty.rows).toEqual([{ daily_cron: null }]);
    await expect(sql`UPDATE chats SET daily_cron = '   '`.execute(handle.db)).rejects.toThrow(
      /chats_daily_cron_not_blank|23514/,
    );
    await sql`UPDATE chats SET daily_cron = '09:00'`.execute(handle.db);
    const stored = await sql<{ daily_cron: string }>`SELECT daily_cron FROM chats`.execute(handle.db);
    expect(stored.rows).toEqual([{ daily_cron: '09:00' }]);
  });
});

describe('E-4 командный топик в участника не пишется', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('E-4 у project_members нет reports_topic_id, у chats нет topic_id', async () => {
    const handle = await openDb();
    opened.push(handle);
    const members = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'project_members'
    `.execute(handle.db);
    const chats = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chats'
    `.execute(handle.db);
    expect(members.rows.map((row) => row.column_name)).not.toContain('reports_topic_id');
    expect(chats.rows.map((row) => row.column_name)).not.toContain('topic_id');
    expect(chats.rows.map((row) => row.column_name)).toContain('reports_topic_id');
  });
});

describe('INV-27 время и включение рассылки задаются на чат', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-27 daily_cron и reports_topic_id есть у группы и нет у проекта; новая группа без них', async () => {
    const handle = await openDb();
    opened.push(handle);
    const projects = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects'
    `.execute(handle.db);
    const names = projects.rows.map((row) => row.column_name);
    expect(names).not.toContain('daily_cron');
    expect(names).not.toContain('reports_topic_id');

    await registerRoot(handle.db);
    const projectId = await createNamed(handle.db, 'Альфа', 'Europe/Moscow', 'alpha');
    const bound = await createChatBinding(handle.db, silentLogger, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId,
      offer: forumAdmin,
      idempotencyKey: 'bind-delivery',
    });
    expect(bound.status).toBe('bound');
    if (bound.status !== 'bound') return;
    expect(bound.chat.reportsTopicId).toBeNull();
    expect(bound.chat.dailyCron).toBeNull();
    const stored = await sql<{ reports_topic_id: string | null; daily_cron: string | null }>`
      SELECT reports_topic_id::text AS reports_topic_id, daily_cron FROM chats
    `.execute(handle.db);
    expect(stored.rows).toEqual([{ reports_topic_id: null, daily_cron: null }]);
  });
});

describe('INV-20 пока группа не привязана, канвас и отчёты некуда отправлять', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-20 до привязки адреса нет, после подтверждения канвас и отчёты идут в группу', async () => {
    expect(canvasAndReportTarget(null)).toBeNull();
    expect(canvasAndReportTarget('   ')).toBeNull();

    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    const projectId = await createNamed(handle.db, 'Альфа', 'Europe/Moscow', 'alpha');
    const before = await sql<{ chat_id: string | null }>`SELECT chat_id::text AS chat_id FROM projects`.execute(handle.db);
    expect(before.rows[0]?.chat_id ?? null).toBeNull();
    expect(canvasAndReportTarget(before.rows[0]?.chat_id ?? null)).toBeNull();

    const bound = await createChatBinding(handle.db, silentLogger, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId,
      offer: forumAdmin,
      idempotencyKey: 'bind-alpha',
    });
    expect(bound.status).toBe('bound');
    if (bound.status !== 'bound') return;
    expect(bound.shared).toBe(false);
    expect(canvasAndReportTarget(bound.chat.id)).toEqual({ chatId: bound.chat.id });
    const after = await sql<{ chat_id: string | null }>`SELECT chat_id::text AS chat_id FROM projects`.execute(handle.db);
    expect(after.rows[0]?.chat_id).toBe(bound.chat.id);
    expect(canvasAndReportTarget(after.rows[0]?.chat_id ?? null)).toEqual({ chatId: bound.chat.id });
  });
});

describe('INV-22 повтор подтверждения супергруппы не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 повтор того же подтверждения не создаёт второго события и не меняет привязку', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    await registerSecond(handle.db);
    const projectId = await createNamed(handle.db, 'Альфа', 'Europe/Moscow', 'alpha');
    const binding = createChatBinding(handle.db, silentLogger, clock);
    const first = await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId,
      offer: forumAdmin,
      idempotencyKey: '80',
    });
    const again = await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId,
      offer: forumAdmin,
      idempotencyKey: '80',
    });
    const otherTap = await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId,
      offer: forumAdmin,
      idempotencyKey: '81',
    });
    expect(first.status).toBe('bound');
    expect(again.status).toBe('unchanged');
    expect(otherTap.status).toBe('unchanged');
    expect(await countChats(handle.db)).toBe(1);
    expect(await chatEvents(handle.db)).toHaveLength(1);

    await expect(
      binding.confirm({
        telegramUserId: String(secondAccount.id),
        projectId,
        offer: forumAdmin,
        idempotencyKey: '82',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CHAT_BIND_ACTOR });
    await expect(
      binding.confirm({
        telegramUserId: String(rootAccount.id),
        projectId,
        offer: { ...forumAdmin, kind: 'topic' },
        idempotencyKey: '83',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CHAT_IS_TOPIC });
    expect(await chatEvents(handle.db)).toHaveLength(1);
  });
});

describe('INV-27 рассылка живёт на группе и общая для её проектов', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-27 второй проект садится в ту же супергруппу и не заводит второй чат', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    const alphaId = await createNamed(handle.db, 'Альфа', 'Europe/Moscow', 'alpha');
    const betaId = await createNamed(handle.db, 'Бета', 'Asia/Yekaterinburg', 'beta');
    const binding = createChatBinding(handle.db, silentLogger, clock);
    const first = await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId: alphaId,
      offer: forumAdmin,
      idempotencyKey: '90',
    });
    const second = await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId: betaId,
      offer: forumAdmin,
      idempotencyKey: '91',
    });
    expect(second.status).toBe('bound');
    if (first.status !== 'bound' || second.status !== 'bound') return;
    expect(second.shared).toBe(true);
    expect(second.chat.id).toBe(first.chat.id);
    expect(second.chat.timezone).toBe('Europe/Moscow');
    expect(await countChats(handle.db)).toBe(1);
    const projects = await sql<{ name: string; chat_id: string; timezone: string }>`
      SELECT name, chat_id::text AS chat_id, timezone FROM projects ORDER BY name
    `.execute(handle.db);
    expect(projects.rows).toEqual([
      { name: 'Альфа', chat_id: first.chat.id, timezone: 'Europe/Moscow' },
      { name: 'Бета', chat_id: first.chat.id, timezone: 'Asia/Yekaterinburg' },
    ]);
    expect(await chatEvents(handle.db)).toHaveLength(2);
  });
});

interface SentMessage {
  chatId: string;
  text: string;
  buttons: string[];
}

function captureApi(sent: SentMessage[], chat: { id: number; type: string; is_forum?: boolean }): Transformer {
  return (async (_prev, method, payload) => {
    if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') {
      const chatId = 'chat_id' in payload ? payload.chat_id : '';
      const buttons: string[] = [];
      if ('reply_markup' in payload && payload.reply_markup && typeof payload.reply_markup === 'object' && 'inline_keyboard' in payload.reply_markup) {
        const rows = payload.reply_markup.inline_keyboard;
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (!Array.isArray(row)) continue;
            for (const button of row) {
              if (button && typeof button === 'object' && 'callback_data' in button && typeof button.callback_data === 'string') {
                buttons.push(button.callback_data);
              }
            }
          }
        }
      }
      sent.push({ chatId: String(chatId), text: payload.text, buttons });
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: Number(chatId), type: 'private' } } };
    }
    if (method === 'answerCallbackQuery') return { ok: true, result: true };
    if (method === 'getChat' && 'chat_id' in payload) {
      return { ok: true, result: { ...chat, id: Number(payload.chat_id) } };
    }
    if (method === 'getChatMember') {
      return {
        ok: true,
        result: {
          status: 'administrator',
          user: { id: testBotInfo.id, is_bot: true, first_name: testBotInfo.first_name },
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: false,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_send_welcome_messages: false,
          can_manage_topics: true,
        },
      };
    }
    return { ok: false, error_code: 400, description: method };
  }) as Transformer;
}

function projectText(name: string, timezone: string): string {
  return `${NEW_PROJECT_HEADING}\n${name}\n\n${timezone}`;
}

function memberBody(updateId: number, chat: { id: number; type: string; title: string; is_forum?: boolean }, status: string, topics: boolean): string {
  return JSON.stringify({
    update_id: updateId,
    my_chat_member: {
      chat,
      from: { id: rootAccount.id, is_bot: false, first_name: rootAccount.first_name },
      date: 1700000000,
      old_chat_member: { status: 'left', user: { id: testBotInfo.id, is_bot: true, first_name: testBotInfo.first_name } },
      new_chat_member: {
        status,
        user: { id: testBotInfo.id, is_bot: true, first_name: testBotInfo.first_name },
        can_be_edited: false,
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: false,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false,
        can_send_welcome_messages: false,
        can_manage_topics: topics,
      },
    },
  });
}

function callbackBody(updateId: number, account: { id: number; first_name: string }, data: string): string {
  return JSON.stringify({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: account.id, is_bot: false, first_name: account.first_name },
      chat_instance: '1',
      data,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: account.id, type: 'private' },
        text: SUPERGROUP_REQUEST,
      },
    },
  });
}

describe('привязка супергруппы в боте', () => {
  const sent: SentMessage[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;
  const forum = { id: Number(telegramChatId), type: 'supergroup', title: 'Команда', is_forum: true };

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  async function post(body: string): Promise<number> {
    if (running === undefined) throw new Error('процесс не запущен');
    return httpStatus(running.port, 'POST', TELEGRAM_WEBHOOK_PATH, body, {
      'X-Telegram-Bot-Api-Secret-Token': 'secret',
    });
  }

  it('просит супергруппу с правами и сажает второй проект в ту же группу одним тапом', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    await registerSecond(handle.db);
    running = await startProcess({
      ...readProcessConfig(env(), clock),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle.db,
    });
    running.bot.api.config.use(captureApi(sent, forum));

    const created = await post(
      JSON.stringify({
        update_id: 51,
        message: {
          message_id: 51,
          date: 1700000000,
          chat: { id: rootAccount.id, type: 'private' },
          from: { id: rootAccount.id, is_bot: false, first_name: rootAccount.first_name },
          text: projectText('Альфа', '10'),
        },
      }),
    );
    expect(created).toBe(200);
    expect(sent.map((message) => message.text)).toContain(SUPERGROUP_REQUEST);
    expect(sent.every((message) => message.buttons.length === 0)).toBe(true);
    expect(await countChats(handle.db)).toBe(0);

    const wrong = await post(memberBody(52, { id: Number(telegramChatId), type: 'group', title: 'Обычная' }, 'administrator', false));
    expect(wrong).toBe(200);
    expect(sent.at(-1)).toMatchObject({ chatId: String(rootAccount.id), text: SUPERGROUP_REQUEST, buttons: [] });
    expect(await countChats(handle.db)).toBe(0);

    const added = await post(memberBody(53, forum, 'administrator', true));
    expect(added).toBe(200);
    const prompt = sent.at(-1);
    expect(prompt?.chatId).toBe(String(rootAccount.id));
    expect(prompt?.text).toBe(SUPERGROUP_REQUEST);
    expect(prompt?.buttons).toHaveLength(1);
    const data = prompt?.buttons[0];
    if (data === undefined) throw new Error('нет кнопки подтверждения');
    expect(data.startsWith('b:')).toBe(true);
    expect(data.endsWith(`:${telegramChatId}`)).toBe(true);

    const stranger = await post(callbackBody(54, secondAccount, data));
    expect(stranger).toBe(200);
    expect(sent.at(-1)?.text).toBe(ACCESS_DENIED_REPLY);
    expect(sent.at(-1)?.text).not.toContain('Альфа');
    expect(await countChats(handle.db)).toBe(0);

    const confirmed = await post(callbackBody(55, rootAccount, data));
    expect(confirmed).toBe(200);
    expect(sent.at(-2)?.text).toBe(SUPERGROUP_BOUND);
    expect(sent.at(-1)?.text.startsWith(PROJECT_REPOSITORY_HEADING)).toBe(true);
    expect(sent.at(-1)?.text).toContain('Альфа');
    expect(await countChats(handle.db)).toBe(1);
    expect(await chatEvents(handle.db)).toHaveLength(1);
    const linked = await sql<{ chat_id: string | null }>`SELECT chat_id::text AS chat_id FROM projects`.execute(handle.db);
    expect(canvasAndReportTarget(linked.rows[0]?.chat_id ?? null)).not.toBeNull();

    const repeat = await post(callbackBody(55, rootAccount, data));
    expect(repeat).toBe(200);
    expect(await chatEvents(handle.db)).toHaveLength(1);

    const secondProject = await post(
      JSON.stringify({
        update_id: 56,
        message: {
          message_id: 56,
          date: 1700000000,
          chat: { id: rootAccount.id, type: 'private' },
          from: { id: rootAccount.id, is_bot: false, first_name: rootAccount.first_name },
          text: projectText('Бета', '12'),
        },
      }),
    );
    expect(secondProject).toBe(200);
    const join = sent.at(-1);
    expect(join?.text).toBe(SUPERGROUP_REQUEST);
    expect(join?.buttons).toHaveLength(1);
    const joinData = join?.buttons[0];
    if (joinData === undefined) throw new Error('нет кнопки для второго проекта');

    const shared = await post(callbackBody(57, rootAccount, joinData));
    expect(shared).toBe(200);
    expect(sent.at(-2)?.text).toBe(SUPERGROUP_SHARED);
    expect(sent.at(-1)?.text.startsWith(PROJECT_REPOSITORY_HEADING)).toBe(true);
    expect(sent.at(-1)?.text).toContain('Бета');
    expect(await countChats(handle.db)).toBe(1);
    const rows = await sql<{ name: string; chat_id: string }>`
      SELECT name, chat_id::text AS chat_id FROM projects ORDER BY name
    `.execute(handle.db);
    expect(rows.rows[0]?.chat_id).toBe(rows.rows[1]?.chat_id);
    expect(await chatEvents(handle.db)).toHaveLength(2);
  });
});
