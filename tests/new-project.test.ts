import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PROJECT_CREATOR_ROLE } from '../src/domain/projects/create-project.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readChatsMigration, readEventsMigration, readProjectMembersMigration, readProjectsMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import {
  NEW_PROJECT_FIELDS,
  NEW_PROJECT_HEADING,
  NEW_PROJECT_REFUSAL,
  parseNewProjectMessage,
  projectCreatedReply,
  replyToNewProject,
} from '../src/telegram/new-project.ts';
import { SUPERGROUP_REQUEST } from '../src/telegram/chat-binding.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const secondAccount = { id: 1002, is_bot: false, first_name: 'Борис' };

const projectText = `${NEW_PROJECT_HEADING}\nАльфа\nучёт команды\nEurope/Moscow`;

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
  const registration = createUserRegistration(db, clock);
  const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  return root.user.id;
}

async function registerSecond(db: Kysely<Database>): Promise<void> {
  const registration = createUserRegistration(db, clock);
  await registration.registerOnStart({ telegramUserId: String(secondAccount.id), name: secondAccount.first_name });
}

async function countProjects(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM projects`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

async function countRoots(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users WHERE is_root`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

interface StoredProject {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chatId: string | null;
  createdAt: string;
}

function payloadOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

async function projectsOf(db: Kysely<Database>): Promise<StoredProject[]> {
  const result = await sql<{
    id: string;
    name: string;
    description: string;
    timezone: string;
    chat_id: string | null;
    created_at: string;
  }>`
    SELECT id::text AS id, name, description, timezone, chat_id::text AS chat_id, created_at::text AS created_at
    FROM projects
    ORDER BY name
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    chatId: row.chat_id,
    createdAt: row.created_at,
  }));
}

interface StoredEvent {
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  actorId: string;
  actorRole: string;
  subjectEntity: string;
  subjectId: string;
}

async function projectEvents(db: Kysely<Database>): Promise<StoredEvent[]> {
  const result = await sql<{
    event_type: string;
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
    subject_id: string;
  }>`
    SELECT event_type, idempotency_key, payload, actor_id, actor_role, subject_entity, subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.PROJECT_CREATED}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: payloadOf(row.payload),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
  }));
}

function captureReplies(sent: string[]): Transformer {
  return (async (_prev, method, payload) => {
    if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') sent.push(payload.text);
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } };
  }) as Transformer;
}

function messageBody(
  updateId: number,
  account: { id: number; first_name: string },
  chat: { id: number; type: string },
  text: string,
): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1700000000,
      chat,
      from: { id: account.id, is_bot: false, first_name: account.first_name },
      text,
    },
  });
}

describe('INV-17 корень в заведённом проекте — lead', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-17 корень заводит проект и в каждом таком проекте он lead', async () => {
    const handle = await openDb();
    opened.push(handle);
    const rootId = await registerRoot(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    const fields = parseNewProjectMessage(projectText);
    if (fields === null) throw new Error('сообщение проекта');
    const first = await replyToNewProject('private', rootAccount, '42', fields, creation);
    const secondText = `${NEW_PROJECT_HEADING}\nБета\n\nAsia/Yekaterinburg`;
    const secondFields = parseNewProjectMessage(secondText);
    if (secondFields === null) throw new Error('сообщение второго проекта');
    const second = await replyToNewProject('private', rootAccount, '43', secondFields, creation);

    expect(first).toBe(projectCreatedReply('Альфа'));
    expect(second).toBe(projectCreatedReply('Бета'));
    expect(PROJECT_CREATOR_ROLE).toBe('lead');
    expect(await countRoots(handle.db)).toBe(1);
    expect(await countProjects(handle.db)).toBe(2);

    const rows = await projectsOf(handle.db);
    expect(rows.map((row) => row.name)).toEqual(['Альфа', 'Бета']);
    expect(rows[0]).toMatchObject({
      name: 'Альфа',
      description: 'учёт команды',
      timezone: 'Europe/Moscow',
      chatId: null,
    });
    expect(rows[1]).toMatchObject({ name: 'Бета', description: '', timezone: 'Asia/Yekaterinburg', chatId: null });
    expect(rows[0]?.createdAt.startsWith('2026-09-28')).toBe(true);

    const events = await projectEvents(handle.db);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.actorRole === PROJECT_CREATOR_ROLE && event.actorId === rootId)).toBe(true);
    expect(events.every((event) => event.subjectEntity === 'Project')).toBe(true);
    expect(events[0]).toMatchObject({
      eventType: EVENT_TYPES.PROJECT_CREATED,
      idempotencyKey: '42',
      payload: {
        name: 'Альфа',
        description: 'учёт команды',
        timezone: 'Europe/Moscow',
        created_by: rootId,
      },
    });
    expect(events[0]?.subjectId).toBe(rows.find((row) => row.name === 'Альфа')?.id);
    expect(events[1]?.payload).toMatchObject({ name: 'Бета', description: '', created_by: rootId });
  });

  it('INV-17 не-корень проект не заводит и корнем не становится', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    await registerSecond(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    const fields = parseNewProjectMessage(projectText);
    if (fields === null) throw new Error('сообщение проекта');
    const reply = await replyToNewProject('private', secondAccount, '44', fields, creation);
    expect(reply).toBe(NEW_PROJECT_REFUSAL);
    expect(reply).not.toContain('Альфа');
    expect(reply).not.toContain('Аня');
    expect(await countProjects(handle.db)).toBe(0);
    expect(await countRoots(handle.db)).toBe(1);
    expect(await projectEvents(handle.db)).toEqual([]);
  });
});

describe('INV-19 проект заводится в личке', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 сообщение вне лички проект не создаёт и ответа не даёт', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    const fields = parseNewProjectMessage(projectText);
    if (fields === null) throw new Error('сообщение проекта');
    const reply = await replyToNewProject('supergroup', rootAccount, '45', fields, creation);
    expect(reply).toBeNull();
    expect(await countProjects(handle.db)).toBe(0);
    expect(await projectEvents(handle.db)).toEqual([]);

    await expect(
      creation.create({
        telegramUserId: String(rootAccount.id),
        name: 'Альфа',
        description: 'учёт команды',
        timezone: 'Europe/Moscow',
        chat: 'supergroup',
        idempotencyKey: '45',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_CHAT });
    expect(await countProjects(handle.db)).toBe(0);
  });

  it('INV-19 без заголовка «Новый проект» и без имени или таймзоны проект не пишется', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    expect(parseNewProjectMessage('Альфа\nописание\nEurope/Moscow')).toBeNull();
    expect(parseNewProjectMessage(`${NEW_PROJECT_HEADING}\nАльфа`)).toBeNull();

    const blankName = parseNewProjectMessage(`${NEW_PROJECT_HEADING}\n  \nописание\nEurope/Moscow`);
    if (blankName === null) throw new Error('пустое имя распознано');
    const nameReply = await replyToNewProject('private', rootAccount, '46', blankName, creation);
    expect(nameReply).toBe(NEW_PROJECT_FIELDS);

    const blankZone = parseNewProjectMessage(`${NEW_PROJECT_HEADING}\nАльфа\nописание\n  `);
    if (blankZone === null) throw new Error('пустая таймзона распознана');
    const zoneReply = await replyToNewProject('private', rootAccount, '47', blankZone, creation);
    expect(zoneReply).toBe(NEW_PROJECT_FIELDS);
    expect(await countProjects(handle.db)).toBe(0);
    expect(await projectEvents(handle.db)).toEqual([]);
  });
});

describe('INV-22 повтор «Новый проект» не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же update не создаёт второй проект и не меняет первый', async () => {
    const handle = await openDb();
    opened.push(handle);
    const rootId = await registerRoot(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    const fields = parseNewProjectMessage(projectText);
    if (fields === null) throw new Error('сообщение проекта');
    const first = await replyToNewProject('private', rootAccount, '48', fields, creation);
    const other = parseNewProjectMessage(`${NEW_PROJECT_HEADING}\nДругое\nдругое описание\nUTC`);
    if (other === null) throw new Error('второе сообщение');
    const again = await replyToNewProject('private', rootAccount, '48', other, creation);
    expect(first).toBe(projectCreatedReply('Альфа'));
    expect(again).toBeNull();
    expect(await countProjects(handle.db)).toBe(1);
    const rows = await projectsOf(handle.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Альфа', description: 'учёт команды', timezone: 'Europe/Moscow' });
    const events = await projectEvents(handle.db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotencyKey: '48',
      actorRole: PROJECT_CREATOR_ROLE,
      payload: { name: 'Альфа', created_by: rootId },
    });
  });

  it('INV-22 пустой ключ проект не записывает', async () => {
    const handle = await openDb();
    opened.push(handle);
    await registerRoot(handle.db);
    const creation = createProjectCreation(handle.db, clock);
    await expect(
      creation.create({
        telegramUserId: String(rootAccount.id),
        name: 'Альфа',
        description: '',
        timezone: 'Europe/Moscow',
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_IDEMPOTENCY_KEY });
    expect(await countProjects(handle.db)).toBe(0);
    expect(await projectEvents(handle.db)).toEqual([]);
  });
});

describe('«Новый проект» в процессе', () => {
  const sent: string[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  async function post(updateId: number, account: { id: number; first_name: string }, chat: { id: number; type: string }, text: string): Promise<number> {
    if (running === undefined) throw new Error('процесс не запущен');
    return httpStatus(running.port, 'POST', TELEGRAM_WEBHOOK_PATH, messageBody(updateId, account, chat, text), {
      'X-Telegram-Bot-Api-Secret-Token': 'secret',
    });
  }

  it('INV-17 корень в личке заводит проект, группа и повтор update — нет', async () => {
    const handle = await openDb();
    opened.push(handle);
    const rootId = await registerRoot(handle.db);
    running = await startProcess({
      ...readProcessConfig(env(), clock),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle.db,
    });
    running.bot.api.config.use(captureReplies(sent));

    const group = await post(50, rootAccount, { id: -100, type: 'supergroup' }, projectText);
    expect(group).toBe(200);
    expect(sent).toEqual([]);
    expect(await countProjects(handle.db)).toBe(0);

    const created = await post(51, rootAccount, { id: rootAccount.id, type: 'private' }, projectText);
    expect(created).toBe(200);
    expect(sent).toEqual([projectCreatedReply('Альфа'), SUPERGROUP_REQUEST]);
    expect(await countProjects(handle.db)).toBe(1);

    const repeat = await post(51, rootAccount, { id: rootAccount.id, type: 'private' }, `${NEW_PROJECT_HEADING}\nДругое\n\nUTC`);
    expect(repeat).toBe(200);
    expect(sent).toEqual([projectCreatedReply('Альфа'), SUPERGROUP_REQUEST]);
    expect(await countProjects(handle.db)).toBe(1);
    const events = await projectEvents(handle.db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotencyKey: '51',
      actorRole: PROJECT_CREATOR_ROLE,
      actorId: rootId,
    });
  });
});
