import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { reportSchedule, SCHEDULE_ACTOR_ROOT } from '../src/domain/projects/schedule.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createChatSchedule } from '../src/infrastructure/schedule.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import {
  afterReportsTopic,
  parseScheduleMessage,
  renderSchedule,
  replyToScheduleMessage,
  SCHEDULE_ACTOR,
  SCHEDULE_ASK,
  SCHEDULE_CLEAR_HINT,
  SCHEDULE_CLEAR_ROOT,
  SCHEDULE_CLEARED,
  SCHEDULE_HEADING,
  SCHEDULE_OFF,
  SCHEDULE_ON,
  SCHEDULE_ROOT_ONLY,
  SCHEDULE_UNBOUND,
  scheduleSavedReply,
  scheduleTemplate,
} from '../src/telegram/schedule.ts';
import { REPORTS_TOPIC_SET } from '../src/telegram/reports-topic.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const leadId = '00000000-0000-4000-8000-0000000000b3';

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  alphaId: string;
  betaId: string | null;
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
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

async function seed(bound: boolean, shared = false): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, silentLogger, clock);
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
  const creation = createProjectCreation(handle.db, silentLogger, clock);
  const alpha = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  await createMembership(handle.db, silentLogger, clock).add({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (${leadId}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE})
  `.execute(handle.db);
  let betaId: string | null = null;
  if (bound) {
    await createChatBinding(handle.db, silentLogger, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId: alpha.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-alpha',
    });
  }
  if (shared) {
    const beta = await creation.create({
      telegramUserId: String(rootAccount.id),
      name: 'Бета',
      description: '',
      timezone: 'Asia/Yekaterinburg',
      chat: 'private',
      idempotencyKey: 'project-beta',
    });
    betaId = beta.project.id;
    await createChatBinding(handle.db, silentLogger, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId: beta.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-beta',
    });
  }
  return { db: handle.db, close: handle.close, alphaId: alpha.project.id, betaId };
}

async function stored(db: Kysely<Database>): Promise<{
  dailyCron: string | null;
  chatTimezone: string;
  chats: number;
  projects: { name: string; timezone: string; chatId: string | null }[];
}> {
  const chat = await sql<{ daily_cron: string | null; timezone: string; n: number }>`
    SELECT daily_cron, timezone, CAST(count(*) OVER () AS int) AS n FROM chats
  `.execute(db);
  const projects = await sql<{ name: string; timezone: string; chat_id: string | null }>`
    SELECT name, timezone, chat_id::text AS chat_id FROM projects ORDER BY name
  `.execute(db);
  const row = chat.rows[0];
  return {
    dailyCron: row?.daily_cron ?? null,
    chatTimezone: row?.timezone ?? '',
    chats: Number(row?.n ?? 0),
    projects: projects.rows.map((item) => ({ name: item.name, timezone: item.timezone, chatId: item.chat_id })),
  };
}

async function scheduleEvents(db: Kysely<Database>, eventType: string): Promise<{ idempotencyKey: string; payload: unknown; actorRole: string }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown; actor_role: string }>`
    SELECT idempotency_key, payload, actor_role
    FROM events
    WHERE event_type = ${eventType}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    actorRole: row.actor_role,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

describe('вопрос времени и таймзоны', () => {
  it('после командного топика бот спрашивает время и таймзону и говорит, что расписание выключено', () => {
    const follow = afterReportsTopic(REPORTS_TOPIC_SET);
    expect(follow.startsWith(REPORTS_TOPIC_SET)).toBe(true);
    expect(follow).toContain(SCHEDULE_ASK);
    expect(follow).toContain(SCHEDULE_OFF);
    expect(parseScheduleMessage(`${SCHEDULE_HEADING}\nАльфа`)).toEqual({ kind: 'show', projectName: 'Альфа' });
    expect(parseScheduleMessage(`${SCHEDULE_HEADING}\nАльфа\n09:00`)).toEqual({
      kind: 'set',
      projectName: 'Альфа',
      dailyTime: '09:00',
    });
    expect(parseScheduleMessage(`${SCHEDULE_HEADING}\nАльфа\n`)).toEqual({ kind: 'clear', projectName: 'Альфа' });
    expect(parseScheduleMessage(`${SCHEDULE_HEADING}\nАльфа\n09:00\nPacific/Auckland`)).toBeNull();
    const off = renderSchedule({ projectName: 'Альфа', bound: true, dailyTime: null, timezone: 'Europe/Moscow', mailing: false });
    expect(off).toContain(SCHEDULE_OFF);
    expect(off).toContain(SCHEDULE_ASK);
    expect(off).toContain(scheduleTemplate('Альфа'));
    expect(off).toContain(SCHEDULE_CLEAR_HINT);
    const on = renderSchedule({ projectName: 'Альфа', bound: true, dailyTime: '09:00', timezone: 'Pacific/Auckland', mailing: true });
    expect(on).toContain('Время отчёта группы: 09:00');
    expect(on).toContain('Таймзона группы: Pacific/Auckland');
    expect(on).toContain(SCHEDULE_ON);
  });
});

describe('INV-24 час отчёта считается по таймзоне группы', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-24 время отчёта берёт таймзону группы и не переписывает таймзоны проектов', async () => {
    const fixture = await seed(true, true);
    opened.push(fixture);
    const actions = createChatSchedule(fixture.db, silentLogger, clock);
    const before = await stored(fixture.db);
    expect(before.chats).toBe(1);
    expect(before.dailyCron).toBeNull();
    expect(before.chatTimezone).toBe('Europe/Moscow');
    expect(reportSchedule({ id: 'chat', timezone: before.chatTimezone, dailyCron: before.dailyCron })).toBeNull();
    expect(before.projects).toEqual([
      { name: 'Альфа', timezone: 'Europe/Moscow', chatId: expect.any(String) as string },
      { name: 'Бета', timezone: 'Asia/Yekaterinburg', chatId: expect.any(String) as string },
    ]);

    const saved = await replyToScheduleMessage(
      'private',
      rootAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '09:00' },
      'set-hour',
      actions,
    );
    expect(saved).toBe(scheduleSavedReply('09:00', 'Europe/Moscow', 'Альфа'));
    const after = await stored(fixture.db);
    expect(after.chats).toBe(1);
    expect(after.dailyCron).toBe('09:00');
    expect(after.chatTimezone).toBe('Europe/Moscow');
    expect(after.projects).toEqual([
      { name: 'Альфа', timezone: 'Europe/Moscow', chatId: before.projects[0]?.chatId },
      { name: 'Бета', timezone: 'Asia/Yekaterinburg', chatId: before.projects[0]?.chatId },
    ]);
    const chatId = before.projects[0]?.chatId;
    if (chatId === undefined || chatId === null) throw new Error('нет группы');
    expect(reportSchedule({ id: chatId, timezone: after.chatTimezone, dailyCron: after.dailyCron })).toEqual({
      chatId,
      dailyTime: '09:00',
      timezone: 'Europe/Moscow',
    });
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_SET)).toEqual([
      {
        idempotencyKey: 'set-hour',
        actorRole: SCHEDULE_ACTOR_ROOT,
        payload: { chat_id: chatId, daily_time: '09:00', timezone: 'Europe/Moscow' },
      },
    ]);
  });
});

describe('INV-27 рассылка живёт на группе и включена, пока задано время', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-27 пока время не названо, рассылка выключена; одно время на группу, не на каждый проект', async () => {
    const loose = await seed(false);
    opened.push(loose);
    const unbound = await replyToScheduleMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-loose',
      createChatSchedule(loose.db, silentLogger, clock),
    );
    expect(unbound).toContain(SCHEDULE_UNBOUND);
    expect((await stored(loose.db)).chats).toBe(0);

    const fixture = await seed(true, true);
    opened.push(fixture);
    const actions = createChatSchedule(fixture.db, silentLogger, clock);
    const asked = await replyToScheduleMessage('private', rootAccount, { kind: 'show', projectName: 'Бета' }, 'show-off', actions);
    expect(asked).toContain(SCHEDULE_OFF);
    expect(asked).toContain(SCHEDULE_ASK);
    expect((await stored(fixture.db)).dailyCron).toBeNull();

    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'
    `.execute(fixture.db);
    expect(columns.rows.map((row) => row.column_name)).not.toContain('daily_cron');

    await actions.set({
      telegramUserId: String(veraAccount.id),
      projectName: 'Альфа',
      dailyTime: ' 18:30 ',
      chat: 'private',
      idempotencyKey: 'lead-set',
    });
    const on = await stored(fixture.db);
    expect(on.chats).toBe(1);
    expect(on.dailyCron).toBe('18:30');
    expect(on.chatTimezone).toBe('Europe/Moscow');
    expect(on.projects.map((project) => project.chatId)).toEqual([on.projects[0]?.chatId, on.projects[0]?.chatId]);
    const shown = await replyToScheduleMessage('private', rootAccount, { kind: 'show', projectName: 'Бета' }, 'show-on', actions);
    expect(shown).toContain(SCHEDULE_ON);
    expect(shown).toContain('Время отчёта группы: 18:30');
    expect(shown).toContain('Таймзона группы: Europe/Moscow');

    const member = await replyToScheduleMessage(
      'private',
      borisAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '10:00' },
      'member-set',
      actions,
    );
    expect(member).toBe(SCHEDULE_ACTOR);
    const leadChange = await replyToScheduleMessage(
      'private',
      veraAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '11:00' },
      'lead-change',
      actions,
    );
    expect(leadChange).toBe(SCHEDULE_ROOT_ONLY);
    const leadClear = await replyToScheduleMessage('private', veraAccount, { kind: 'clear', projectName: 'Альфа' }, 'lead-clear', actions);
    expect(leadClear).toBe(SCHEDULE_CLEAR_ROOT);
    expect((await stored(fixture.db)).dailyCron).toBe('18:30');

    const outside = await replyToScheduleMessage(
      'supergroup',
      rootAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '12:00' },
      'group',
      actions,
    );
    expect(outside).toBeNull();
    const cleared = await replyToScheduleMessage('private', rootAccount, { kind: 'clear', projectName: 'Бета' }, 'clear-root', actions);
    expect(cleared).toBe(SCHEDULE_CLEARED);
    const off = await stored(fixture.db);
    expect(off.dailyCron).toBeNull();
    expect(off.chatTimezone).toBe('Europe/Moscow');
    expect(off.chats).toBe(1);
    expect(off.projects).toEqual([
      { name: 'Альфа', timezone: 'Europe/Moscow', chatId: on.projects[0]?.chatId },
      { name: 'Бета', timezone: 'Asia/Yekaterinburg', chatId: on.projects[0]?.chatId },
    ]);
    expect(reportSchedule({ id: 'chat', timezone: off.chatTimezone, dailyCron: off.dailyCron })).toBeNull();
    const again = await replyToScheduleMessage('private', rootAccount, { kind: 'clear', projectName: 'Альфа' }, 'clear-again', actions);
    expect(again).toBe(SCHEDULE_OFF);
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_SET)).toHaveLength(1);
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_CLEARED)).toEqual([
      {
        idempotencyKey: 'clear-root',
        actorRole: SCHEDULE_ACTOR_ROOT,
        payload: { chat_id: on.projects[0]?.chatId },
      },
    ]);
    const roles = await sql<{ role: string }>`SELECT role FROM project_members ORDER BY role`.execute(fixture.db);
    expect(roles.rows.map((row) => row.role)).toEqual([LEAD_ROLE, LEAD_ROLE, LEAD_ROLE, MEMBER_ROLE]);
  });
});

describe('INV-22 повтор расписания не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не меняет время и таймзону и не пишет второе событие', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createChatSchedule(fixture.db, silentLogger, clock);
    const first = await replyToScheduleMessage(
      'private',
      rootAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '09:00' },
      'same-key',
      actions,
    );
    expect(first).toBe(scheduleSavedReply('09:00', 'Europe/Moscow', 'Альфа'));
    const second = await replyToScheduleMessage(
      'private',
      rootAccount,
      { kind: 'set', projectName: 'Альфа', dailyTime: '22:00' },
      'same-key',
      actions,
    );
    expect(second).toBeNull();
    const row = await stored(fixture.db);
    expect(row.dailyCron).toBe('09:00');
    expect(row.chatTimezone).toBe('Europe/Moscow');
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_SET)).toHaveLength(1);
    await expect(
      actions.set({
        telegramUserId: String(rootAccount.id),
        projectName: 'Альфа',
        dailyTime: '09:00',
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.SCHEDULE_IDEMPOTENCY_KEY });
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_SET)).toHaveLength(1);
  });

  it('INV-22 повтор стирания тем же ключом не пишет второе событие и не затирает новое время', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createChatSchedule(fixture.db, silentLogger, clock);
    await actions.set({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      dailyTime: '09:00',
      chat: 'private',
      idempotencyKey: 'set-before-clear',
    });
    const cleared = await actions.clear({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      chat: 'private',
      idempotencyKey: 'clear-once',
    });
    expect(cleared.changed).toBe(true);
    expect(cleared.board.mailing).toBe(false);
    await actions.set({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      dailyTime: '11:00',
      chat: 'private',
      idempotencyKey: 'set-after-clear',
    });
    await expect(
      actions.clear({
        telegramUserId: String(rootAccount.id),
        projectName: 'Альфа',
        chat: 'private',
        idempotencyKey: 'clear-once',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.SCHEDULE_DUPLICATE });
    const row = await stored(fixture.db);
    expect(row.dailyCron).toBe('11:00');
    expect(row.chatTimezone).toBe('Europe/Moscow');
    expect(await scheduleEvents(fixture.db, EVENT_TYPES.CHAT_SCHEDULE_CLEARED)).toHaveLength(1);
  });
});
