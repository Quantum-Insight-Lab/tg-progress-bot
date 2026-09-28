import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORTS_TOPIC_ACTOR_ROOT, REPORTS_TOPIC_NAME } from '../src/domain/projects/reports-topic.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createExecutorTopics } from '../src/infrastructure/executor-topic.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createReportsTopics } from '../src/infrastructure/reports-topic.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { replyToExecutorTopicMessage, type TopicChannel } from '../src/telegram/executor-topic.ts';
import {
  REPORTS_TOPIC_ACTOR,
  REPORTS_TOPIC_ALREADY,
  REPORTS_TOPIC_COLLIDES,
  REPORTS_TOPIC_CREATED,
  REPORTS_TOPIC_EMPTY,
  REPORTS_TOPIC_HEADING,
  REPORTS_TOPIC_QUESTION,
  REPORTS_TOPIC_ROOT_ONLY,
  REPORTS_TOPIC_SET,
  hasReportsCallbackData,
  parseReportsCallback,
  parseReportsTopicMessage,
  renderReportsTopic,
  replyToCreateReportsTopic,
  replyToHasReportsTopic,
  replyToReportsTopicMessage,
  reportsTopicLine,
  specifyReportsTemplate,
  type ReportsChannel,
} from '../src/telegram/reports-topic.ts';
import { afterReportsTopic } from '../src/telegram/schedule.ts';

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
  borisId: string;
  veraId: string;
}

interface Opened {
  chat: string;
  name: string;
}

function channel(nextId: () => number): { api: ReportsChannel; opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    opened,
    api: {
      async create(chat, name) {
        opened.push({ chat, name });
        return nextId();
      },
    },
  };
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

async function seed(bound: boolean): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, clock);
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
  const creation = createProjectCreation(handle.db, clock);
  const alpha = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  await createMembership(handle.db, clock).add({
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
  if (bound) {
    await createChatBinding(handle.db, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId: alpha.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-alpha',
    });
  }
  return {
    db: handle.db,
    close: handle.close,
    alphaId: alpha.project.id,
    borisId: boris.user.id,
    veraId: vera.user.id,
  };
}

async function storedReports(db: Kysely<Database>): Promise<{ topicId: string | null; chats: number; projectChats: number }> {
  const topic = await sql<{ reports_topic_id: string | null }>`
    SELECT reports_topic_id::text AS reports_topic_id FROM chats
  `.execute(db);
  const chats = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM chats`.execute(db);
  const links = await sql<{ n: number }>`
    SELECT CAST(count(DISTINCT chat_id) AS int) AS n FROM projects WHERE chat_id IS NOT NULL
  `.execute(db);
  return {
    topicId: topic.rows[0]?.reports_topic_id ?? null,
    chats: Number(chats.rows[0]?.n ?? 0),
    projectChats: Number(links.rows[0]?.n ?? 0),
  };
}

async function memberTopics(db: Kysely<Database>): Promise<{ userId: string; role: string; topicId: string | null }[]> {
  const result = await sql<{ user_id: string; role: string; topic_id: string | null }>`
    SELECT user_id::text AS user_id, role, topic_id::text AS topic_id
    FROM project_members
    ORDER BY role, user_id::text
  `.execute(db);
  return result.rows.map((row) => ({ userId: row.user_id, role: row.role, topicId: row.topic_id }));
}

async function reportsEvents(db: Kysely<Database>): Promise<{ idempotencyKey: string; payload: unknown; actorRole: string }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown; actor_role: string }>`
    SELECT idempotency_key, payload, actor_role
    FROM events
    WHERE event_type = ${EVENT_TYPES.CHAT_REPORTS_TOPIC_SET}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    actorRole: row.actor_role,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

describe('INV-27 командный топик общий у группы и отдельный от топиков исполнителей', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-27 пока супергруппа не привязана, командный топик пуст', async () => {
    const loose = await seed(false);
    opened.push(loose);
    const actions = createReportsTopics(loose.db, clock);
    const unbound = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-unbound',
      actions,
    );
    expect(unbound?.text).toBe([REPORTS_TOPIC_HEADING, 'Альфа', '', REPORTS_TOPIC_EMPTY].join('\n'));
    expect(unbound?.markup).toBeUndefined();
    expect(unbound?.text).not.toContain(REPORTS_TOPIC_QUESTION);
    expect(await reportsEvents(loose.db)).toEqual([]);
  });

  it('INV-27 бот спрашивает, есть ли командный топик', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const boundActions = createReportsTopics(fixture.db, clock);
    const view = await replyToReportsTopicMessage(
      'private',
      veraAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-bound',
      boundActions,
    );
    expect(view?.text).toContain(REPORTS_TOPIC_QUESTION);
    expect(renderReportsTopic({ projectName: 'Альфа', bound: true, reportsTopicId: null })).toContain(REPORTS_TOPIC_QUESTION);
    const rows = view?.markup?.inline_keyboard ?? [];
    expect(rows).toHaveLength(2);
    const hasButton = rows[0]?.[0];
    const createButton = rows[1]?.[0];
    const hasData = hasButton !== undefined && 'callback_data' in hasButton ? hasButton.callback_data : '';
    const createData = createButton !== undefined && 'callback_data' in createButton ? createButton.callback_data : '';
    expect(parseReportsCallback(hasData)).toEqual({ action: 'has', projectId: fixture.alphaId });
    expect(parseReportsCallback(createData)).toEqual({ action: 'create', projectId: fixture.alphaId });
    expect(hasReportsCallbackData(fixture.alphaId)).toBe(`ry:${fixture.alphaId}`);

    const member = await replyToReportsTopicMessage(
      'private',
      borisAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-member',
      boundActions,
    );
    expect(member?.text).toBe(REPORTS_TOPIC_ACTOR);
    const outside = await replyToReportsTopicMessage(
      'group',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-group',
      boundActions,
    );
    expect(outside).toBeNull();
    expect(await reportsEvents(fixture.db)).toEqual([]);
    expect((await storedReports(fixture.db)).topicId).toBeNull();
  });

  it('INV-27 если топик есть, руководитель указывает его; в топики исполнителей номер не пишется', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createReportsTopics(fixture.db, clock);
    const prompt = await replyToHasReportsTopic('private', veraAccount, fixture.alphaId, actions);
    expect(prompt?.text).toBe(specifyReportsTemplate('Альфа'));
    expect(parseReportsTopicMessage(prompt?.text ?? '')).toEqual({ kind: 'invalid-topic' });
    expect((await storedReports(fixture.db)).topicId).toBeNull();

    const set = await replyToReportsTopicMessage(
      'private',
      veraAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 42 },
      'specify-vera',
      actions,
    );
    expect(set?.text).toBe(afterReportsTopic(REPORTS_TOPIC_SET));
    expect(await storedReports(fixture.db)).toMatchObject({ topicId: '42', chats: 1, projectChats: 1 });
    expect(await memberTopics(fixture.db)).toEqual([
      { userId: fixture.veraId, role: LEAD_ROLE, topicId: null },
      { userId: fixture.borisId, role: MEMBER_ROLE, topicId: null },
    ]);
    expect(await reportsEvents(fixture.db)).toEqual([
      {
        idempotencyKey: 'specify-vera',
        actorRole: LEAD_ROLE,
        payload: { chat_id: expect.any(String) as string, topic_id: 42, created: false },
      },
    ]);

    const again = await replyToReportsTopicMessage(
      'private',
      veraAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 7 },
      'specify-vera-again',
      actions,
    );
    expect(again?.text).toBe(REPORTS_TOPIC_ROOT_ONLY);
    expect((await storedReports(fixture.db)).topicId).toBe('42');

    const changed = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 8 },
      'specify-root',
      actions,
    );
    expect(changed?.text).toBe(afterReportsTopic(REPORTS_TOPIC_SET));
    expect((await storedReports(fixture.db)).topicId).toBe('8');
    const events = await reportsEvents(fixture.db);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.idempotencyKey === 'specify-root')).toMatchObject({
      actorRole: REPORTS_TOPIC_ACTOR_ROOT,
      payload: { topic_id: 8, created: false },
    });
  });

  it('INV-27 если топика нет, бот создаёт «Отчёты»; второй проект группы получает тот же топик', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createReportsTopics(fixture.db, clock);
    const gate = channel(() => 15);
    const created = await replyToCreateReportsTopic('private', rootAccount, fixture.alphaId, 'create-reports', actions, gate.api);
    expect(created?.text).toBe(afterReportsTopic(REPORTS_TOPIC_CREATED));
    expect(gate.opened).toEqual([{ chat: telegramChatId, name: REPORTS_TOPIC_NAME }]);
    expect((await storedReports(fixture.db)).topicId).toBe('15');
    expect(await reportsEvents(fixture.db)).toEqual([
      {
        idempotencyKey: 'create-reports',
        actorRole: REPORTS_TOPIC_ACTOR_ROOT,
        payload: { chat_id: expect.any(String) as string, topic_id: 15, created: true },
      },
    ]);
    expect(await memberTopics(fixture.db)).toEqual([
      { userId: fixture.veraId, role: LEAD_ROLE, topicId: null },
      { userId: fixture.borisId, role: MEMBER_ROLE, topicId: null },
    ]);

    const beta = await createProjectCreation(fixture.db, clock).create({
      telegramUserId: String(rootAccount.id),
      name: 'Бета',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-beta',
    });
    const shared = await createChatBinding(fixture.db, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId: beta.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-beta',
    });
    expect(shared.status).toBe('bound');
    if (shared.status !== 'bound') return;
    expect(shared.shared).toBe(true);

    const screen = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Бета' },
      'show-beta',
      actions,
    );
    expect(screen?.text).toContain(reportsTopicLine(15));
    expect(screen?.text).not.toContain(REPORTS_TOPIC_QUESTION);
    expect(screen?.markup).toBeUndefined();
    const second = await replyToCreateReportsTopic('private', rootAccount, beta.project.id, 'create-beta', actions, gate.api);
    expect(second?.text).toBe(REPORTS_TOPIC_ALREADY);
    expect(gate.opened).toHaveLength(1);
    const stored = await storedReports(fixture.db);
    expect(stored).toMatchObject({ topicId: '15', chats: 1, projectChats: 1 });
    expect(await reportsEvents(fixture.db)).toHaveLength(1);
  });

  it('INV-27 командный топик не совпадает с топиком исполнителя', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const topics = createExecutorTopics(fixture.db, clock);
    const reports = createReportsTopics(fixture.db, clock);
    await topics.specify({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      memberName: 'Борис',
      topicId: 15,
      chat: 'private',
      idempotencyKey: 'executor-boris',
    });

    const clash = await replyToReportsTopicMessage(
      'private',
      veraAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 15 },
      'reports-clash',
      reports,
    );
    expect(clash?.text).toBe(REPORTS_TOPIC_COLLIDES);
    expect((await storedReports(fixture.db)).topicId).toBeNull();
    expect(await reportsEvents(fixture.db)).toEqual([]);
    expect(await memberTopics(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '15' });

    await reports.specify({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      topicId: 16,
      chat: 'private',
      idempotencyKey: 'reports-ok',
    });
    const reverse = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-after',
      reports,
    );
    expect(reverse?.text).toContain(reportsTopicLine(16));

    const told: { chat: string; topicId: number; text: string }[] = [];
    const executorChannel: TopicChannel = {
      async create() {
        return 1;
      },
      async tell(chat, topicId, text) {
        told.push({ chat, topicId, text });
      },
      async direct() {
        return undefined;
      },
    };
    const blocked = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Вера', topicId: 16 },
      'executor-clash',
      topics,
      executorChannel,
    );
    expect(blocked?.text).toBe(REPORTS_TOPIC_COLLIDES);
    expect(told).toEqual([]);
    expect(await memberTopics(fixture.db)).toContainEqual({ userId: fixture.veraId, role: LEAD_ROLE, topicId: null });
    expect((await storedReports(fixture.db)).topicId).toBe('16');
  });
});

describe('INV-22 повтор командного топика не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не меняет командный топик и не пишет второе событие', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createReportsTopics(fixture.db, clock);
    const first = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 42 },
      'same-key',
      actions,
    );
    expect(first?.text).toBe(afterReportsTopic(REPORTS_TOPIC_SET));
    const second = await replyToReportsTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', topicId: 99 },
      'same-key',
      actions,
    );
    expect(second).toBeNull();
    expect((await storedReports(fixture.db)).topicId).toBe('42');
    expect(await reportsEvents(fixture.db)).toHaveLength(1);

    await expect(
      actions.specify({
        telegramUserId: String(rootAccount.id),
        projectName: 'Альфа',
        topicId: 7,
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.REPORTS_TOPIC_IDEMPOTENCY_KEY });
    await expect(
      actions.assign({
        telegramUserId: String(rootAccount.id),
        projectId: fixture.alphaId,
        topicId: 0,
        created: false,
        chat: 'private',
        idempotencyKey: 'zero',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.REPORTS_TOPIC_ID });
    expect((await storedReports(fixture.db)).topicId).toBe('42');
    expect(await reportsEvents(fixture.db)).toHaveLength(1);
  });

  it('INV-22 повтор того же создания не открывает второй топик «Отчёты»', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createReportsTopics(fixture.db, clock);
    const gate = channel(() => 21);
    const first = await replyToCreateReportsTopic('private', rootAccount, fixture.alphaId, 'create-once', actions, gate.api);
    expect(first?.text).toBe(afterReportsTopic(REPORTS_TOPIC_CREATED));
    const second = await replyToCreateReportsTopic('private', rootAccount, fixture.alphaId, 'create-once', actions, gate.api);
    expect(second).toBeNull();
    expect(gate.opened).toEqual([{ chat: telegramChatId, name: REPORTS_TOPIC_NAME }]);
    expect((await storedReports(fixture.db)).topicId).toBe('21');
    expect(await reportsEvents(fixture.db)).toHaveLength(1);
  });
});
