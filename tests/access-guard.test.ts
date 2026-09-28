import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ACCESS_ACTOR_ID,
  ACCESS_ACTOR_ROLE,
  ACCESS_SUBJECT,
  admitOrDeny,
  mayAnswer,
  type AccessProfile,
} from '../src/domain/projects/access.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES, type EventJournal, type EventRow } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { ACCESS_DENIED_REPLY, GUARDED_HANDLERS, type GuardedHandler } from '../src/telegram/access-guard.ts';
import { NEW_PROJECT_HEADING } from '../src/telegram/new-project.ts';
import { EXECUTOR_TOPIC_HEADING } from '../src/telegram/executor-topic.ts';
import { PARTICIPANTS_HEADING, PARTICIPANTS_ROOT_ONLY } from '../src/telegram/members.ts';
import { START_REPLY_PENDING } from '../src/telegram/start.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };

const outside: AccessProfile = { userId: null, isRoot: false, isParticipant: false };
const rootProfile: AccessProfile = { userId: '00000000-0000-4000-8000-000000000001', isRoot: true, isParticipant: false };
const memberProfile: AccessProfile = { userId: '00000000-0000-4000-8000-000000000003', isRoot: false, isParticipant: true };
const knownOutside: AccessProfile = { userId: '00000000-0000-4000-8000-000000000002', isRoot: false, isParticipant: false };

function memoryJournal(): { journal: EventJournal; rows: EventRow[] } {
  const rows: EventRow[] = [];
  return {
    rows,
    journal: {
      async append(row) {
        const found = rows.find((item) => item.idempotencyKey === row.idempotencyKey);
        if (found !== undefined) return { inserted: false, row: found };
        rows.push(row);
        return { inserted: true, row };
      },
    },
  };
}

describe('INV-16 бот отвечает только корню и участникам', () => {
  it('INV-16 корень и участник проходят, посторонний получает access.denied без строки пользователя', async () => {
    expect(mayAnswer(rootProfile)).toBe(true);
    expect(mayAnswer(memberProfile)).toBe(true);
    expect(mayAnswer(outside)).toBe(false);
    expect(mayAnswer(knownOutside)).toBe(false);

    const stored = memoryJournal();
    const denied = await admitOrDeny(stored.journal, clock, outside, {
      telegramUserId: '3002',
      updateKind: 'message',
      idempotencyKey: '801',
    });
    expect(denied).toBe('deny');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      eventType: EVENT_TYPES.ACCESS_DENIED,
      idempotencyKey: '801',
      actorId: ACCESS_ACTOR_ID,
      actorRole: ACCESS_ACTOR_ROLE,
      subjectEntity: ACCESS_SUBJECT,
      subjectId: '3002',
      payload: { telegram_user_id: 3002, update_kind: 'message' },
    });

    const again = await admitOrDeny(stored.journal, clock, knownOutside, {
      telegramUserId: '1002',
      updateKind: 'message',
      idempotencyKey: '801',
    });
    expect(again).toBe('deny');
    expect(stored.rows).toHaveLength(1);

    const allowed = await admitOrDeny(stored.journal, clock, rootProfile, {
      telegramUserId: '1001',
      updateKind: 'message',
      idempotencyKey: '802',
    });
    expect(allowed).toBe('allow');
    expect(stored.rows).toHaveLength(1);

    await expect(
      admitOrDeny(stored.journal, clock, outside, { telegramUserId: '3002', updateKind: 'message', idempotencyKey: '   ' }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.ACCESS_IDEMPOTENCY_KEY });
    await expect(
      admitOrDeny(stored.journal, clock, outside, { telegramUserId: '0', updateKind: 'message', idempotencyKey: '803' }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TELEGRAM_USER_ID });
    expect(stored.rows).toHaveLength(1);
  });
});

function env(): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    PORT: '0',
    SCHEDULER_INTERVAL_MS: '60000',
  };
}

function captureReplies(sent: string[]): Transformer {
  return (async (_prev, method, payload) => {
    if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') sent.push(payload.text);
    if (method === 'answerCallbackQuery') return { ok: true, result: true };
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: 1, type: 'private' } } };
    }
    return { ok: true, result: true };
  }) as Transformer;
}

function messageBody(updateId: number, account: { id: number; first_name: string }, text: string, command = false): string {
  const message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; first_name: string };
    text: string;
    entities?: { type: string; offset: number; length: number }[];
  } = {
    message_id: updateId,
    date: 1700000000,
    chat: { id: account.id, type: 'private' },
    from: { id: account.id, is_bot: false, first_name: account.first_name },
    text,
  };
  if (command) message.entities = [{ type: 'bot_command', offset: 0, length: text.length }];
  return JSON.stringify({ update_id: updateId, message });
}

function callbackBody(updateId: number, account: { id: number; first_name: string }): string {
  return JSON.stringify({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: account.id, is_bot: false, first_name: account.first_name },
      chat_instance: '1',
      data: 'b:00000000-0000-4000-8000-000000000010:-100123',
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: account.id, type: 'private' },
        text: 'кнопка',
      },
    },
  });
}

function bodyFor(handler: GuardedHandler, updateId: number, account: { id: number; first_name: string }): string {
  switch (handler) {
    case 'start':
      return messageBody(updateId, account, '/start', true);
    case 'new-project':
      return messageBody(updateId, account, `${NEW_PROJECT_HEADING}\nСекрет\n\nEurope/Moscow`);
    case 'chat-binding':
      return callbackBody(updateId, account);
    case 'participants':
      return messageBody(updateId, account, `${PARTICIPANTS_HEADING}\nАльфа`);
    case 'executor-topic':
      return messageBody(updateId, account, `${EXECUTOR_TOPIC_HEADING}\nАльфа`);
    default: {
      const unreachable: never = handler;
      throw new Error(unreachable);
    }
  }
}

describe('INV-16 guard на входе всех обработчиков', () => {
  const sent: string[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

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

  async function fresh(body: string): Promise<string[]> {
    const mark = sent.length;
    const status = await post(body);
    expect(status).toBe(200);
    return sent.slice(mark);
  }

  it('INV-16 постороннему отказ на каждом обработчике, /start только регистрирует, данные не раскрываются', async () => {
    const pglite = new PGlite();
    await pglite.exec(readEventsMigration());
    await pglite.exec(readUsersMigration());
    await pglite.exec(readProjectsMigration());
    await pglite.exec(readChatsMigration());
    await pglite.exec(readProjectMembersMigration());
    const handle = new Kysely<Database>({
      dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
    });
    opened.push({
      async close() {
        await handle.destroy();
      },
    });
    const registration = createUserRegistration(handle, clock);
    const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
    const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
    const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
    const creation = createProjectCreation(handle, clock);
    const alpha = await creation.create({
      telegramUserId: String(rootAccount.id),
      name: 'Альфа',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-alpha',
    });
    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES (${'00000000-0000-4000-8000-0000000000a3'}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, 'member')
    `.execute(handle);

    running = await startProcess({
      ...readProcessConfig(env(), clock),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle,
    });
    running.bot.api.config.use(captureReplies(sent));

    const leaked = ['Аня', 'Борис', 'Вера', 'Альфа', 'Секрет'];
    let updateId = 810;
    for (const handler of GUARDED_HANDLERS) {
      const account = { id: 4000 + updateId, first_name: 'Чужой' };
      const replies = await fresh(bodyFor(handler, updateId, account));
      if (handler === 'start') {
        expect(replies).toEqual([START_REPLY_PENDING]);
        const known = await sql<{ n: number }>`
          SELECT CAST(count(*) AS int) AS n FROM users WHERE telegram_user_id::text = ${String(account.id)}
        `.execute(handle);
        expect(Number(known.rows[0]?.n)).toBe(1);
      } else {
        expect(replies).toEqual([ACCESS_DENIED_REPLY]);
        for (const word of leaked) expect(replies[0]).not.toContain(word);
        const known = await sql<{ n: number }>`
          SELECT CAST(count(*) AS int) AS n FROM users WHERE telegram_user_id::text = ${String(account.id)}
        `.execute(handle);
        expect(Number(known.rows[0]?.n)).toBe(0);
      }
      updateId += 1;
    }

    const borisBody = bodyFor('new-project', updateId, borisAccount);
    const borisDenied = await fresh(borisBody);
    expect(borisDenied).toEqual([ACCESS_DENIED_REPLY]);
    expect(borisDenied[0]).not.toContain('Секрет');
    expect(borisDenied[0]).not.toContain('Альфа');
    const projects = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM projects`.execute(handle);
    expect(Number(projects.rows[0]?.n)).toBe(1);
    const members = await sql<{ user_id: string }>`SELECT user_id::text AS user_id FROM project_members`.execute(handle);
    expect(members.rows.map((row) => row.user_id)).toEqual([vera.user.id]);

    const repeated = await fresh(borisBody);
    expect(repeated).toEqual([ACCESS_DENIED_REPLY]);
    const deniedEvents = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events
      WHERE event_type = ${EVENT_TYPES.ACCESS_DENIED} AND idempotency_key = ${String(updateId)}
    `.execute(handle);
    expect(Number(deniedEvents.rows[0]?.n)).toBe(1);

    const memberReply = await fresh(bodyFor('participants', updateId + 1, veraAccount));
    expect(memberReply).toEqual([PARTICIPANTS_ROOT_ONLY]);
    expect(memberReply[0]).not.toContain('Борис');
    const memberDenied = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events
      WHERE event_type = ${EVENT_TYPES.ACCESS_DENIED} AND idempotency_key = ${String(updateId + 1)}
    `.execute(handle);
    expect(Number(memberDenied.rows[0]?.n)).toBe(0);

    const rootReply = await fresh(bodyFor('participants', updateId + 2, rootAccount));
    expect(rootReply[0]).toContain('Альфа');
    expect(rootReply[0]).toContain('Борис');
    expect(rootReply[0]).not.toBe(ACCESS_DENIED_REPLY);
    const rootMembership = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM project_members WHERE user_id = ${root.user.id}::uuid
    `.execute(handle);
    expect(Number(rootMembership.rows[0]?.n)).toBe(0);
    expect(boris.user.isRoot).toBe(false);
    expect(root.user.isRoot).toBe(true);
  });
});
