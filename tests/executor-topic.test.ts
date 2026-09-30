import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTOR_TOPIC_ACTOR_ROLE } from '../src/domain/projects/executor-topic.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import { createExecutorTopics } from '../src/infrastructure/executor-topic.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { renderFirstEmployeeMessage } from '../src/projections/first-employee-message.ts';
import {
  EXECUTOR_TOPIC_ALREADY,
  EXECUTOR_TOPIC_CREATED,
  EXECUTOR_TOPIC_EMPTY,
  EXECUTOR_TOPIC_HEADING,
  EXECUTOR_TOPIC_ROOT_ONLY,
  EXECUTOR_TOPIC_SET,
  parseExecutorTopicMessage,
  parseTopicCallback,
  renderExecutorTopics,
  replyToCreateTopic,
  replyToExecutorTopicMessage,
  replyToHasTopic,
  TASK_IN_TOPIC,
  topicQuestion,
  type TopicChannel,
} from '../src/telegram/executor-topic.ts';
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
  borisId: string;
  veraId: string;
}

interface Told {
  chat: string;
  topicId: number;
  text: string;
}

interface Directed {
  telegramUserId: string;
  text: string;
}

interface Opened {
  chat: string;
  name: string;
}

function employeeText(topicId: number, githubLogin: string | null = null): string {
  return renderFirstEmployeeMessage({ projectName: 'Альфа', topicId, githubLogin });
}

function channel(nextId: () => number): { api: TopicChannel; told: Told[]; directed: Directed[]; opened: Opened[] } {
  const told: Told[] = [];
  const directed: Directed[] = [];
  const opened: Opened[] = [];
  return {
    told,
    directed,
    opened,
    api: {
      async create(chat, name) {
        opened.push({ chat, name });
        return nextId();
      },
      async tell(chat, topicId, text) {
        told.push({ chat, topicId, text });
      },
      async direct(telegramUserId, text) {
        directed.push({ telegramUserId, text });
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
  const registration = createUserRegistration(handle.db, silentLogger, clock);
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
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
  const membership = createMembership(handle.db, silentLogger, clock);
  await membership.add({
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
    await createChatBinding(handle.db, silentLogger, clock).confirm({
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

async function topicsOf(db: Kysely<Database>): Promise<{ userId: string; role: string; topicId: string | null }[]> {
  const result = await sql<{ user_id: string; role: string; topic_id: string | null }>`
    SELECT user_id::text AS user_id, role, topic_id::text AS topic_id
    FROM project_members
    ORDER BY role, user_id::text
  `.execute(db);
  return result.rows.map((row) => ({ userId: row.user_id, role: row.role, topicId: row.topic_id }));
}

async function topicEvents(db: Kysely<Database>): Promise<{ idempotencyKey: string; payload: unknown; actorRole: string }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown; actor_role: string }>`
    SELECT idempotency_key, payload, actor_role
    FROM events
    WHERE event_type = ${EVENT_TYPES.MEMBER_TOPIC_SET}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    actorRole: row.actor_role,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

describe('топик исполнителя — колонка project_members.topic_id', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('topic_id живёт на участнике, в chats его нет, ноль и отрицательный номер не пишутся', async () => {
    const fixture = await seed(false);
    opened.push(fixture);
    const members = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'project_members'
      ORDER BY column_name
    `.execute(fixture.db);
    expect(members.rows.map((row) => row.column_name)).toContain('topic_id');
    const chats = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chats'
      ORDER BY column_name
    `.execute(fixture.db);
    expect(chats.rows.map((row) => row.column_name)).not.toContain('topic_id');
    const zero = sql`
      UPDATE project_members SET topic_id = 0 WHERE user_id = ${fixture.borisId}::uuid
    `.execute(fixture.db);
    await expect(zero).rejects.toThrow(/project_members_topic_id_positive|23514/);
    const negative = sql`
      UPDATE project_members SET topic_id = -1 WHERE user_id = ${fixture.borisId}::uuid
    `.execute(fixture.db);
    await expect(negative).rejects.toThrow(/project_members_topic_id_positive|23514/);
    expect(await topicsOf(fixture.db)).toEqual([
      { userId: fixture.veraId, role: LEAD_ROLE, topicId: null },
      { userId: fixture.borisId, role: MEMBER_ROLE, topicId: null },
    ]);
  });
});

describe('INV-23 канвас живёт в одном топике исполнителя', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-23 пока супергруппа не привязана, топик пуст и канвас некуда ставить', async () => {
    const fixture = await seed(false);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 41);
    const screen = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-unbound',
      actions,
      gate.api,
    );
    expect(screen?.text).toBe([EXECUTOR_TOPIC_HEADING, 'Альфа', '', EXECUTOR_TOPIC_EMPTY].join('\n'));
    expect(screen?.markup).toBeUndefined();
    const created = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-unbound',
      actions,
      gate.api,
    );
    expect(created?.text).toBe(EXECUTOR_TOPIC_EMPTY);
    expect(gate.opened).toEqual([]);
    expect(gate.told).toEqual([]);
    expect(gate.directed).toEqual([]);
    expect(await topicsOf(fixture.db)).toEqual([
      { userId: fixture.veraId, role: LEAD_ROLE, topicId: null },
      { userId: fixture.borisId, role: MEMBER_ROLE, topicId: null },
    ]);
    expect(await topicEvents(fixture.db)).toEqual([]);
  });

  it('INV-23 бот сначала спрашивает, есть ли топик, и канвас не уходит в личку', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const screen = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-bound',
      actions,
      channel(() => 1).api,
    );
    expect(screen?.text).toContain(topicQuestion('Борис'));
    expect(screen?.text).toContain(topicQuestion('Вера'));
    expect(screen?.text).toContain('Борис — member');
    expect(screen?.text).toContain('Вера — lead');
    expect(screen?.text).not.toContain(TASK_IN_TOPIC);
    const parsed = parseExecutorTopicMessage(`${EXECUTOR_TOPIC_HEADING}\nАльфа`);
    expect(parsed).toEqual({ kind: 'show', projectName: 'Альфа' });
    const has = parseTopicCallback(`ty:${fixture.alphaId}:${borisAccount.id}`);
    expect(has).toEqual({ action: 'has', projectId: fixture.alphaId, telegramUserId: String(borisAccount.id) });
    const hint = await replyToHasTopic('private', rootAccount, fixture.alphaId, String(borisAccount.id), actions);
    expect(hint?.text).toBe([EXECUTOR_TOPIC_HEADING, 'Альфа', 'Борис', '<номер>'].join('\n'));
    expect(await topicsOf(fixture.db)).toEqual([
      { userId: fixture.veraId, role: LEAD_ROLE, topicId: null },
      { userId: fixture.borisId, role: MEMBER_ROLE, topicId: null },
    ]);

    const gate = channel(() => 77);
    const specified = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'specify-boris',
      actions,
      gate.api,
    );
    expect(specified?.text).toBe(EXECUTOR_TOPIC_SET);
    expect(specified?.text).not.toBe(TASK_IN_TOPIC);
    expect(gate.opened).toEqual([]);
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 42, text: employeeText(42) }]);
    expect(gate.directed).toEqual([{ telegramUserId: String(borisAccount.id), text: employeeText(42) }]);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '42' });
    const events = await topicEvents(fixture.db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotencyKey: 'specify-boris',
      actorRole: EXECUTOR_TOPIC_ACTOR_ROLE,
      payload: { project_id: fixture.alphaId, user_id: fixture.borisId, topic_id: 42, created: false },
    });
  });

  it('INV-23 топик есть и у lead, второй топик тому же человеку не создаётся', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    let seq = 10;
    const gate = channel(() => {
      seq += 1;
      return seq;
    });
    const lead = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(veraAccount.id),
      'create-vera',
      actions,
      gate.api,
    );
    expect(lead?.text).toBe(EXECUTOR_TOPIC_CREATED);
    expect(gate.opened).toEqual([{ chat: telegramChatId, name: 'Вера' }]);
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 11, text: employeeText(11) }]);
    expect(gate.directed).toEqual([{ telegramUserId: String(veraAccount.id), text: employeeText(11) }]);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.veraId, role: LEAD_ROLE, topicId: '11' });

    const again = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(veraAccount.id),
      'create-vera-again',
      actions,
      gate.api,
    );
    expect(again?.text).toBe(EXECUTOR_TOPIC_ALREADY);
    expect(gate.opened).toHaveLength(1);
    expect(gate.told).toHaveLength(1);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.veraId, role: LEAD_ROLE, topicId: '11' });
    const events = await topicEvents(fixture.db);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ user_id: fixture.veraId, topic_id: 11, created: true });

    const member = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-boris',
      actions,
      gate.api,
    );
    expect(member?.text).toBe(EXECUTOR_TOPIC_CREATED);
    expect(gate.opened[1]).toEqual({ chat: telegramChatId, name: 'Борис' });
    const rendered = renderExecutorTopics({
      projectName: 'Альфа',
      bound: true,
      members: [
        { name: 'Борис', role: MEMBER_ROLE, topicId: 12 },
        { name: 'Вера', role: LEAD_ROLE, topicId: 11 },
      ],
    });
    expect(rendered).toContain('Топик 11');
    expect(rendered).toContain('Топик 12');
    expect(rendered).not.toContain(topicQuestion('Вера'));
  });

  it('INV-23 участник, который не корень, топик не указывает', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 5);
    const reply = await replyToExecutorTopicMessage(
      'private',
      borisAccount,
      { kind: 'show', projectName: 'Альфа' },
      'show-boris',
      actions,
      gate.api,
    );
    expect(reply?.text).toBe(EXECUTOR_TOPIC_ROOT_ONLY);
    expect(reply?.text).not.toContain('Вера');
    expect(gate.told).toEqual([]);
    expect(gate.directed).toEqual([]);
    expect(await topicEvents(fixture.db)).toEqual([]);
  });
});

describe('INV-22 повтор указания топика не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не меняет топик и не пишет второе событие', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 3);
    const first = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'same-key',
      actions,
      gate.api,
    );
    expect(first?.text).toBe(EXECUTOR_TOPIC_SET);
    const second = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 99 },
      'same-key',
      actions,
      gate.api,
    );
    expect(second).toBeNull();
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 42, text: employeeText(42) }]);
    expect(gate.directed).toEqual([{ telegramUserId: String(borisAccount.id), text: employeeText(42) }]);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '42' });
    expect(await topicEvents(fixture.db)).toHaveLength(1);

    const empty = actions.specify({
      telegramUserId: String(rootAccount.id),
      projectName: 'Альфа',
      memberName: 'Борис',
      topicId: 7,
      chat: 'private',
      idempotencyKey: '   ',
    });
    await expect(empty).rejects.toMatchObject({ code: DOMAIN_ERROR.TOPIC_IDEMPOTENCY_KEY });
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '42' });
    expect(await topicEvents(fixture.db)).toHaveLength(1);
  });

  it('INV-22 повтор того же создания не открывает второй топик', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 21);
    const first = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-once',
      actions,
      gate.api,
    );
    expect(first?.text).toBe(EXECUTOR_TOPIC_CREATED);
    const second = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-once',
      actions,
      gate.api,
    );
    expect(second).toBeNull();
    expect(gate.opened).toEqual([{ chat: telegramChatId, name: 'Борис' }]);
    expect(gate.told).toHaveLength(1);
    expect(gate.directed).toHaveLength(1);
    expect(await topicEvents(fixture.db)).toHaveLength(1);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '21' });
  });
});

describe('первое сообщение сотруднику', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-102 человек открывает свой топик в группе проекта', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 42);
    await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'open-topic',
      actions,
      gate.api,
    );
    const text = employeeText(42);
    expect(text).toContain('Откройте топик 42 в группе проекта «Альфа»');
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 42, text }]);
    expect(await topicsOf(fixture.db)).toContainEqual({ userId: fixture.borisId, role: MEMBER_ROLE, topicId: '42' });
  });

  it('R-572 одним текстом в личку и R-573 тем же текстом в его топик', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 42);
    const reply = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'same-text',
      actions,
      gate.api,
    );
    const text = employeeText(42);
    expect(reply?.text).toBe(EXECUTOR_TOPIC_SET);
    expect(gate.directed).toEqual([{ telegramUserId: String(borisAccount.id), text }]);
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 42, text }]);
    expect(gate.directed[0]?.text).toBe(gate.told[0]?.text);
  });

  it('INV-23 личка не дублирует канвас и не показывает меню задач', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 42);
    await replyToCreateTopic('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'canvas-home', actions, gate.api);
    const text = employeeText(42);
    expect(gate.told).toEqual([{ chat: telegramChatId, topicId: 42, text }]);
    expect(gate.directed).toEqual([{ telegramUserId: String(borisAccount.id), text }]);
    expect(gate.directed[0]?.telegramUserId).not.toBe(telegramChatId);
    expect(text).not.toContain('в план');
    expect(text).not.toContain('подтвердить');
    expect(text).not.toContain('отменить');
    expect(text).toContain(TASK_IN_TOPIC);
    expect(gate.told).toHaveLength(1);
  });

  it('R-577 место в бэклоге при логине и R-578 без логина этой строки нет', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await sql`UPDATE users SET github_login = 'boris' WHERE id = ${fixture.borisId}::uuid`.execute(fixture.db);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const withLogin = channel(() => 42);
    await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'with-login',
      actions,
      withLogin.api,
    );
    const loggedIn = employeeText(42, 'boris');
    expect(withLogin.directed[0]?.text).toBe(loggedIn);
    expect(withLogin.told[0]?.text).toBe(loggedIn);
    expect(loggedIn).toContain('Место в бэклоге — issues, где вы assignee.');

    const without = channel(() => 7);
    await replyToCreateTopic('private', rootAccount, fixture.alphaId, String(veraAccount.id), 'vera-no-login', actions, without.api);
    const plain = employeeText(7);
    expect(without.directed[0]?.text).toBe(plain);
    expect(without.told[0]?.text).toBe(plain);
    expect(plain).not.toContain('Место в бэклоге');
  });

  it('INV-22 повтор ключа не шлёт первое сообщение второй раз', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const actions = createExecutorTopics(fixture.db, silentLogger, clock);
    const gate = channel(() => 42);
    await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'once-message',
      actions,
      gate.api,
    );
    const again = await replyToExecutorTopicMessage(
      'private',
      rootAccount,
      { kind: 'specify', projectName: 'Альфа', memberName: 'Борис', topicId: 42 },
      'once-message',
      actions,
      gate.api,
    );
    expect(again).toBeNull();
    expect(gate.directed).toHaveLength(1);
    expect(gate.told).toHaveLength(1);
    expect(await topicEvents(fixture.db)).toHaveLength(1);
  });
});
