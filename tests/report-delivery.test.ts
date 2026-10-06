import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { scheduledReportKey } from '../src/domain/projects/deliver-report.ts';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readBlockersMigration,
  readChatsMigration,
  readEventsMigration,
  readCiMirrorMigration,
  readCommitsMigration,
  readIssuesMigration,
  readPullRequestsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createReportCommands, deliverDueReports } from '../src/infrastructure/report-delivery.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { REPORT_ACCESS, REPORT_UNBOUND, renderReportDocuments, replyToReportCommand } from '../src/telegram/report.ts';
import { dailyReport, DAILY_REPORT_DM, DAILY_REPORT_TEAM } from '../src/projections/daily-report.ts';
import { zonedDayStart } from '../src/infrastructure/zoned-day.ts';
import { silentLogger } from './log-lines.ts';

let now = new Date('2026-09-28T07:33:00.000Z');
const clock: Clock = { now: () => now };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const reportsTopicId = 22;
const executorTopicId = 11;

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
  borisId: string;
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(readCommitsMigration());
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
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
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
  return { db: handle.db, close: handle.close, alphaId: alpha.project.id, betaId, borisId: boris.user.id };
}

async function chatIdOf(db: Kysely<Database>): Promise<string> {
  const row = await sql<{ id: string }>`SELECT id::text AS id FROM chats`.execute(db);
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error('нет группы');
  return id;
}

async function placeSchedule(db: Kysely<Database>, timezone: string, dailyTime: string | null, topicId: number | null): Promise<void> {
  await sql`
    UPDATE chats
    SET timezone = ${timezone},
        daily_cron = ${dailyTime},
        reports_topic_id = ${topicId}
  `.execute(db);
}

async function placeExecutorTopic(db: Kysely<Database>, userId: string): Promise<void> {
  await sql`
    UPDATE project_members SET topic_id = ${executorTopicId} WHERE user_id = ${userId}::uuid
  `.execute(db);
}

async function reportEvents(db: Kysely<Database>): Promise<{ key: string; payload: Record<string, unknown>; role: string }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown; actor_role: string }>`
    SELECT idempotency_key, payload, actor_role FROM events WHERE event_type = ${EVENT_TYPES.REPORT_SENT} ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    key: row.idempotency_key,
    role: row.actor_role,
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
  }));
}

const quiet = { confirmed: 0, created: 0, cancelled: 0, blocked: 0 };
const noShare = { completed: 0, remaining: 0, ratio: null };

function projectCard(name: string, chatId: string, memberIds: readonly string[], tasks = quiet) {
  return {
    chatId,
    memberIds,
    backlog: {
      projectName: name,
      shareAtStart: noShare,
      shareAtEnd: noShare,
      remainderAtEnd: null,
      closed: [],
      openedNew: [],
      confirmedOn: [],
    },
    tasks,
    cancelled: [],
    now: [],
    next: [],
    risk: { reasons: [], defaultBranchCiRed: false, pullRequests: [] },
    divergence: false,
    repository: null,
  };
}

describe('INV-24 час отчёта считается по таймзоне группы', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-24 до названного часа в таймзоне группы отчёт не уходит, даже если в таймзоне проекта час уже прошёл', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await placeSchedule(fixture.db, 'Pacific/Auckland', '09:00', reportsTopicId);
    const chatId = await chatIdOf(fixture.db);
    const sent: { topicId: number | null; text: string }[] = [];
    const beforeHour = new Date('2026-09-28T19:00:00.000Z');
    await deliverDueReports(fixture.db, silentLogger, beforeHour, renderReportDocuments, async (message) => {
      sent.push(message);
    });
    expect(sent).toEqual([]);
    expect(await reportEvents(fixture.db)).toEqual([]);

    const atHour = new Date('2026-09-28T20:00:00.000Z');
    await deliverDueReports(fixture.db, silentLogger, atHour, renderReportDocuments, async (message) => {
      sent.push(message);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.topicId).toBe(reportsTopicId);
    const events = await reportEvents(fixture.db);
    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe(scheduledReportKey(chatId, '2026-09-29'));
    expect(events[0]?.payload.trigger).toBe('schedule');
    expect(events[0]?.payload.topic_id).toBe(reportsTopicId);
    expect(events[0]?.payload.period_start).toBe(zonedDayStart('2026-09-29', 'Pacific/Auckland').toISOString());
    expect(events[0]?.payload.period_end).toBe(atHour.toISOString());
    const payload = events[0]?.payload;
    await sql`UPDATE chats SET timezone = 'Etc/GMT+12'`.execute(fixture.db);
    await deliverDueReports(fixture.db, silentLogger, atHour, renderReportDocuments, async () => {
      throw new Error('повтор не шлётся');
    });
    expect(await reportEvents(fixture.db)).toEqual([{ key: events[0]?.key, role: events[0]?.role, payload }]);
  });
});

describe('INV-22 повтор отчёта не применяется второй раз', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ход расписания и тот же update не пишут второй факт и не шлют второй текст', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await placeSchedule(fixture.db, 'Pacific/Auckland', '09:00', reportsTopicId);
    const atHour = new Date('2026-09-28T20:00:00.000Z');
    const sent: string[] = [];
    await deliverDueReports(fixture.db, silentLogger, atHour, renderReportDocuments, async (message) => {
      sent.push(message.text);
    });
    await deliverDueReports(fixture.db, silentLogger, atHour, renderReportDocuments, async () => {
      sent.push('лишнее');
    });
    expect(sent).toHaveLength(1);
    expect(await reportEvents(fixture.db)).toHaveLength(1);

    now = new Date('2026-09-28T07:33:00.000Z');
    const actions = createReportCommands(fixture.db, silentLogger, clock, renderReportDocuments);
    const first = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'upd-1', actions);
    const again = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'upd-1', actions);
    expect(again).toBeNull();
    expect(first?.text).toContain('Альфа');
    const commands = (await reportEvents(fixture.db)).filter((event) => event.payload.trigger === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.key).toBe('upd-1');
  });
});

describe('INV-27 личный /report живёт без рассылки, групповой отвечает сразу', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-27 без времени рассылка молчит, /report в личке и в группе отвечает, до топика — в том же чате', async () => {
    const loose = await seed(false);
    opened.push(loose);
    now = new Date('2026-09-28T07:33:00.000Z');
    const looseActions = createReportCommands(loose.db, silentLogger, clock, renderReportDocuments);
    const denied = await replyToReportCommand({ type: 'supergroup', id: telegramChatId }, borisAccount, 'group-loose', looseActions);
    expect(denied?.text).toBe(REPORT_UNBOUND);
    const personal = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'dm-off', looseActions);
    expect(personal?.telegramChatId).toBe(String(borisAccount.id));
    expect(personal?.topicId).toBeNull();
    expect(personal?.text).toContain('Альфа');
    expect(await deliverDueReports(loose.db, silentLogger, now, renderReportDocuments, async () => undefined)).toBeUndefined();

    const fixture = await seed(true, true);
    opened.push(fixture);
    await placeExecutorTopic(fixture.db, fixture.borisId);
    const actions = createReportCommands(fixture.db, silentLogger, clock, renderReportDocuments);
    const sameChat = await replyToReportCommand({ type: 'supergroup', id: telegramChatId }, borisAccount, 'group-same', actions);
    expect(sameChat?.telegramChatId).toBe(telegramChatId);
    expect(sameChat?.topicId).toBeNull();
    expect(sameChat?.text).toContain('Альфа');
    expect(sameChat?.text).toContain('Бета');
    const stranger = await replyToReportCommand({ type: 'supergroup', id: telegramChatId }, veraAccount, 'group-vera', actions);
    expect(stranger?.text).toBe(REPORT_ACCESS);

    await placeSchedule(fixture.db, 'Europe/Moscow', null, null);
    const sent: unknown[] = [];
    await deliverDueReports(fixture.db, silentLogger, new Date('2026-09-28T06:00:00.000Z'), renderReportDocuments, async (message) => {
      sent.push(message);
    });
    expect(sent).toEqual([]);
    const stillPersonal = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'dm-cleared', actions);
    expect(stillPersonal?.text).toContain('Альфа');
    expect(stillPersonal?.text).not.toContain('Бета');
  });
});

describe('INV-26 личка — проекты человека, группа — один текст в командный топик', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-26 /report из группы уходит в командный топик одним сообщением и не в топик исполнителя', async () => {
    const fixture = await seed(true, true);
    opened.push(fixture);
    await placeSchedule(fixture.db, 'Europe/Moscow', '09:00', reportsTopicId);
    await placeExecutorTopic(fixture.db, fixture.borisId);
    now = new Date('2026-09-28T07:33:00.000Z');
    const actions = createReportCommands(fixture.db, silentLogger, clock, renderReportDocuments);
    const group = await replyToReportCommand({ type: 'supergroup', id: telegramChatId }, borisAccount, 'group-topic', actions);
    expect(group?.topicId).toBe(reportsTopicId);
    expect(group?.topicId).not.toBe(executorTopicId);
    expect(group?.text).toContain('Альфа');
    expect(group?.text).toContain('Бета');
    const personal = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'dm-boris', actions);
    expect(personal?.topicId).toBeNull();
    expect(personal?.text).toContain('Альфа');
    expect(personal?.text).not.toContain('Бета');
    const chatId = await chatIdOf(fixture.db);
    const events = await reportEvents(fixture.db);
    const team = events.find((event) => event.payload.target === 'group');
    expect(team?.payload.topic_id).toBe(reportsTopicId);
    expect(team?.payload.chat_id).toBe(chatId);
    expect(events.filter((event) => event.payload.trigger === 'schedule')).toEqual([]);
  });
});

describe('INV-25 строки отчёта считаются из фактов', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-25 одинаковые факты дают один и тот же текст, созданная в сутках задача увеличивает счётчик', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const chatId = await chatIdOf(fixture.db);
    now = new Date('2026-09-28T07:33:00.000Z');
    const actions = createReportCommands(fixture.db, silentLogger, clock, renderReportDocuments);
    const first = await replyToReportCommand({ type: 'private', id: String(rootAccount.id) }, rootAccount, 'root-1', actions);
    const second = await replyToReportCommand({ type: 'private', id: String(rootAccount.id) }, rootAccount, 'root-2', actions);
    const expected = dailyReport({
      chatId,
      date: '2026-09-28',
      audience: DAILY_REPORT_DM,
      memberId: (await sql<{ id: string }>`SELECT id::text AS id FROM users WHERE is_root`.execute(fixture.db)).rows[0]?.id ?? '',
      shareAtStart: noShare,
      shareAtEnd: noShare,
      remainderAtEnd: null,
      projects: [projectCard('Альфа', chatId, [(await sql<{ id: string }>`SELECT id::text AS id FROM users WHERE is_root`.execute(fixture.db)).rows[0]?.id ?? '', fixture.borisId])],
    });
    expect(first?.text).toBe(expected);
    expect(second?.text).toBe(expected);

    await sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES (
        '00000000-0000-4000-8000-0000000000c1'::uuid,
        ${fixture.alphaId}::uuid,
        1,
        'Сигнал',
        'IN_PROGRESS',
        'normal',
        ${fixture.borisId}::uuid,
        ${now.toISOString()}::timestamptz,
        ${now.toISOString()}::timestamptz
      )
    `.execute(fixture.db);
    await sql`
      INSERT INTO events (
        id, source, event_type, payload, created_at, idempotency_key, causation_id, correlation_id,
        schema_version, actor_id, actor_role, subject_entity, subject_id
      ) VALUES (
        '00000000-0000-4000-8000-0000000000e1'::uuid,
        'telegram',
        ${EVENT_TYPES.TASK_CREATED},
        ${JSON.stringify({ task_id: '00000000-0000-4000-8000-0000000000c1', project_id: fixture.alphaId, number: 1, title: 'Сигнал', assignee_id: fixture.borisId, priority: 'normal' })}::jsonb,
        ${now.toISOString()}::timestamptz,
        'task-created-1',
        NULL,
        NULL,
        1,
        ${fixture.borisId},
        'assignee',
        'Task',
        '00000000-0000-4000-8000-0000000000c1'
      )
    `.execute(fixture.db);
    const withTask = await replyToReportCommand({ type: 'private', id: String(borisAccount.id) }, borisAccount, 'boris-task', actions);
    expect(withTask?.text).toContain('создано 1');
    expect(withTask?.text).toContain('Сигнал');
    expect(withTask?.text).not.toContain('Бета');
    const team = await replyToReportCommand({ type: 'supergroup', id: telegramChatId }, borisAccount, 'team-task', actions);
    expect(team?.text).toContain('создано 1');
    expect(team?.text).toContain('Сигнал');
    expect(team?.text).toContain('Борис');
    expect(team?.text).toBe(
      dailyReport({
        chatId,
        date: '2026-09-28',
        audience: DAILY_REPORT_TEAM,
        memberId: null,
        shareAtStart: noShare,
        shareAtEnd: noShare,
        remainderAtEnd: null,
        projects: [
          {
            ...projectCard('Альфа', chatId, [fixture.borisId], { confirmed: 0, created: 1, cancelled: 0, blocked: 0 }),
            now: [{ number: 1, title: 'Сигнал', day: 1, assigneeName: 'Борис', assigneeId: fixture.borisId }],
          },
        ],
      }),
    );
  });
});

describe('R-665 строка «Все проекты» берётся из issues репозитория', () => {
  const opened: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-665 доля на начало и конец суток печатает «Все проекты», пустая заглушка её не съедает', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    now = new Date('2026-09-28T07:33:00.000Z');
    await sql`
      INSERT INTO repositories (id, owner, name) VALUES ('42', 'lab', 'bot')
    `.execute(fixture.db);
    await sql`
      UPDATE projects SET repository_id = '42' WHERE id = ${fixture.alphaId}::uuid
    `.execute(fixture.db);
    await sql`
      INSERT INTO issues (id, repository_id, issue_number, title, state, state_reason, updated_at, closed_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000d1'::uuid, '42', 1, 'Старое', 'closed', 'completed', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('00000000-0000-4000-8000-0000000000d2'::uuid, '42', 2, 'Открытое', 'open', NULL, '2026-09-20T00:00:00.000Z', NULL),
        ('00000000-0000-4000-8000-0000000000d3'::uuid, '42', 3, 'Закрыто сегодня', 'closed', 'completed', '2026-09-28T01:00:00.000Z', '2026-09-28T01:00:00.000Z')
    `.execute(fixture.db);
    const actions = createReportCommands(fixture.db, silentLogger, clock, renderReportDocuments);
    const report = await replyToReportCommand({ type: 'private', id: String(rootAccount.id) }, rootAccount, 'share-line', actions);
    expect(report?.text).toContain('Все проекты: 33% → 67% · осталось 1 из 3');
    expect(report?.text).toContain('Бэклог: 33% → 67% · осталось 1 из 3');
    expect(report?.text).toContain('Закрыто: #3 Закрыто сегодня');
  });
});
