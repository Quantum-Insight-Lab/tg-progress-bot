import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { isFirstLead } from '../src/domain/projects/user.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readEventsMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { emit, EVENT_TYPES } from '../src/events/index.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { replyToStart, START_REPLY_PENDING, START_REPLY_ROOT } from '../src/telegram/start.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T00:00:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const secondAccount = { id: 1002, is_bot: false, first_name: 'Борис', last_name: 'Петров' };

function env(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    PORT: '0',
    SCHEDULER_INTERVAL_MS: '60000',
  };
}

async function openUsers(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
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

async function countUsers(db: Kysely<Database>, onlyRoot = false): Promise<number> {
  const result = onlyRoot
    ? await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users WHERE is_root`.execute(db)
    : await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

interface StoredEvent {
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
}

function payloadOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

async function storedEvents(db: Kysely<Database>): Promise<StoredEvent[]> {
  const result = await sql<{ event_type: string; idempotency_key: string; payload: unknown }>`
    SELECT event_type, idempotency_key, payload FROM events ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: payloadOf(row.payload),
  }));
}

function captureReplies(sent: string[]): Transformer {
  return (async (_prev, method, payload) => {
    if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') sent.push(payload.text);
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } };
  }) as Transformer;
}

function startBody(updateId: number, account: { id: number; first_name: string; last_name?: string }, chat: { id: number; type: string; title?: string }): string {
  const text = '/start';
  const from: { id: number; is_bot: boolean; first_name: string; last_name?: string } = {
    id: account.id,
    is_bot: false,
    first_name: account.first_name,
  };
  if (account.last_name !== undefined) from.last_name = account.last_name;
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat,
      from,
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  });
}

describe('INV-17 корень один — первый /start', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-17 первый /start создаёт корня и первого lead, второй корнем не становится', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    const rootReply = await replyToStart('private', rootAccount, registration);
    const secondReply = await replyToStart('private', secondAccount, registration);
    expect(rootReply).toBe(START_REPLY_ROOT);
    expect(secondReply).toBe(START_REPLY_PENDING);
    expect(await countUsers(handle.db)).toBe(2);
    expect(await countUsers(handle.db, true)).toBe(1);

    const rows = await sql<{ telegram_user_id: string; name: string; is_root: boolean }>`
      SELECT CAST(telegram_user_id AS text) AS telegram_user_id, name, is_root FROM users ORDER BY telegram_user_id
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { telegram_user_id: '1001', name: 'Аня', is_root: true },
      { telegram_user_id: '1002', name: 'Борис Петров', is_root: false },
    ]);
    const root = rows.rows[0];
    const second = rows.rows[1];
    if (root === undefined || second === undefined) throw new Error('строки пользователей');
    expect(
      isFirstLead({
        id: 'root',
        telegramUserId: root.telegram_user_id,
        githubLogin: null,
        name: root.name,
        isRoot: root.is_root,
      }),
    ).toBe(true);
    expect(
      isFirstLead({
        id: 'second',
        telegramUserId: second.telegram_user_id,
        githubLogin: null,
        name: second.name,
        isRoot: second.is_root,
      }),
    ).toBe(false);

    const events = await storedEvents(handle.db);
    expect(events.map((event) => event.idempotencyKey)).toEqual(['1001', '1002']);
    expect(events.map((event) => event.eventType)).toEqual(['user.registered', 'user.registered']);
    expect(events[0]?.payload).toMatchObject({ telegram_user_id: 1001, name: 'Аня', is_root: true });
    expect(events[1]?.payload).toMatchObject({ telegram_user_id: 1002, name: 'Борис Петров', is_root: false });
  });

  it('INV-17 пустое имя и чужой telegram_user_id пользователя не создают', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    await expect(replyToStart('private', { id: 1001, is_bot: false, first_name: '   ' }, registration)).rejects.toMatchObject({
      code: DOMAIN_ERROR.BLANK_NAME,
    });
    await expect(registration.registerOnStart({ telegramUserId: '0', name: 'Аня' })).rejects.toMatchObject({
      code: DOMAIN_ERROR.TELEGRAM_USER_ID,
    });
    expect(await countUsers(handle.db)).toBe(0);
    expect(await storedEvents(handle.db)).toEqual([]);
  });
});

describe('INV-16 новый пользователь ничего не может, пока корень не добавит его', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-16 ответ не корню не раскрывает данных и не называет его руководителем', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    await replyToStart('private', rootAccount, registration);
    const reply = await replyToStart('private', secondAccount, registration);
    expect(reply).toBe(START_REPLY_PENDING);
    expect(reply).not.toContain('Аня');
    expect(reply).not.toContain(START_REPLY_ROOT);
    expect(reply?.includes('руководитель')).toBe(false);
  });

  it('INV-16 /start вне лички не регистрирует и не отвечает', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    const reply = await replyToStart('supergroup', secondAccount, registration);
    expect(reply).toBeNull();
    expect(await countUsers(handle.db)).toBe(0);
    expect(await storedEvents(handle.db)).toEqual([]);
  });
});

describe('INV-22 повтор /start не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 повтор того же аккаунта не создаёт второго события и не меняет имя', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    const first = await registration.registerOnStart({ telegramUserId: '1001', name: '  Аня  ' });
    const again = await registration.registerOnStart({ telegramUserId: '1001', name: 'Другое имя' });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.user).toEqual(first.user);
    expect(again.user.name).toBe('Аня');
    expect(again.user.isRoot).toBe(true);
    expect(await countUsers(handle.db)).toBe(1);
    const events = await storedEvents(handle.db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: EVENT_TYPES.USER_REGISTERED,
      idempotencyKey: '1001',
      payload: { user_id: first.user.id, telegram_user_id: 1001, name: 'Аня', is_root: true },
    });
  });

  it('INV-22 событие с тем же ключом не даёт вставить второго пользователя', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const userId = '00000000-0000-4000-8000-000000000009';
    await emit(createEventJournal(handle.db, silentLogger), {
      type: EVENT_TYPES.USER_REGISTERED,
      source: 'telegram',
      idempotencyKey: '1001',
      payload: { user_id: userId, telegram_user_id: 1001, name: 'Аня', is_root: true },
      actor: { id: userId, role: 'user' },
      subject: { entity: 'User', id: userId },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    await expect(registration.registerOnStart({ telegramUserId: '1001', name: 'Аня' })).rejects.toMatchObject({
      code: DOMAIN_ERROR.REGISTRATION_DUPLICATE,
    });
    expect(await countUsers(handle.db)).toBe(0);
    expect(await storedEvents(handle.db)).toHaveLength(1);
  });
});

describe('/start в процессе', () => {
  const sent: string[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  async function post(updateId: number, account: { id: number; first_name: string; last_name?: string }, chat: { id: number; type: string; title?: string }): Promise<number> {
    if (running === undefined) throw new Error('процесс не запущен');
    return httpStatus(running.port, 'POST', TELEGRAM_WEBHOOK_PATH, startBody(updateId, account, chat), {
      'X-Telegram-Bot-Api-Secret-Token': 'secret',
    });
  }

  it('INV-17 вход в группу не создаёт пользователя, /start в личке создаёт корня', async () => {
    const handle = await openUsers();
    opened.push(handle);
    running = await startProcess({
      ...readProcessConfig(env(), clock),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle.db,
    });
    running.bot.api.config.use(captureReplies(sent));

    const joined = await post(1, secondAccount, { id: -100, type: 'supergroup', title: 'Секретный проект' });
    expect(joined).toBe(200);
    expect(sent).toEqual([]);
    expect(await countUsers(handle.db)).toBe(0);

    const root = await post(2, rootAccount, { id: rootAccount.id, type: 'private' });
    expect(root).toBe(200);
    const member = await post(3, secondAccount, { id: secondAccount.id, type: 'private' });
    expect(member).toBe(200);
    expect(sent).toEqual([START_REPLY_ROOT, START_REPLY_PENDING]);
    expect(sent[1]).not.toContain('Аня');
    expect(sent[1]).not.toContain('Секретный проект');
    expect(await countUsers(handle.db)).toBe(2);
    expect(await countUsers(handle.db, true)).toBe(1);
  });
});
