import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMBERSHIP_ACTOR_ROLE, removeProjectMember, type MembershipStore, type ProjectMemberView } from '../src/domain/projects/membership.ts';
import { LEAD_ROLE, MEMBER_ROLE, leadsTasks } from '../src/domain/projects/member.ts';
import type { User } from '../src/domain/projects/user.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES, type EventJournal, type EventRow } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import {
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import {
  addedReply,
  parseMemberCallback,
  parseParticipantsMessage,
  PARTICIPANTS_ABSENT,
  PARTICIPANTS_ACCESS,
  PARTICIPANTS_HEADING,
  PARTICIPANTS_IN_PROJECT,
  PARTICIPANTS_NOT_IN_PROJECT,
  PARTICIPANTS_NO_PROJECT,
  PARTICIPANTS_ROOT_ONLY,
  removeConfirmText,
  removedReply,
  renderParticipants,
  replyToAddMember,
  replyToConfirmRemoval,
  replyToParticipantsMessage,
  replyToRemovalRequest,
} from '../src/telegram/members.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };

const projectAlpha = '00000000-0000-4000-8000-000000000010';
const projectBeta = '00000000-0000-4000-8000-000000000011';
const borisId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-0000000000a2';
const taskOne = '00000000-0000-4000-8000-0000000000c1';
const taskTwo = '00000000-0000-4000-8000-0000000000c2';

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  rootId: string;
  borisId: string;
  veraId: string;
  alphaId: string;
  betaId: string;
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readTasksMigration());
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

async function seed(): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, silentLogger, clock);
  const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
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
  const beta = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Бета',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-beta',
  });
  return {
    db: handle.db,
    close: handle.close,
    rootId: root.user.id,
    borisId: boris.user.id,
    veraId: vera.user.id,
    alphaId: alpha.project.id,
    betaId: beta.project.id,
  };
}

interface MemberRow {
  projectId: string;
  userId: string;
  role: string;
}

function expectMembership(fixture: Fixture, rows: MemberRow[], extra: MemberRow[] = []): void {
  const expected = [
    { projectId: fixture.alphaId, userId: fixture.rootId, role: LEAD_ROLE },
    { projectId: fixture.betaId, userId: fixture.rootId, role: LEAD_ROLE },
    ...extra,
  ];
  expect(rows).toHaveLength(expected.length);
  expect(rows).toEqual(expect.arrayContaining(expected));
}

async function membersOf(db: Kysely<Database>): Promise<MemberRow[]> {
  const result = await sql<{ project_id: string; user_id: string; role: string }>`
    SELECT project_id::text AS project_id, user_id::text AS user_id, role
    FROM project_members
    ORDER BY project_id::text, role, user_id::text
  `.execute(db);
  return result.rows.map((row) => ({ projectId: row.project_id, userId: row.user_id, role: row.role }));
}

interface StoredEvent {
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  actorId: string;
  actorRole: string;
  subjectEntity: string;
}

function payloadOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

async function eventsOf(db: Kysely<Database>, eventType: string): Promise<StoredEvent[]> {
  const result = await sql<{
    event_type: string;
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
  }>`
    SELECT event_type, idempotency_key, payload, actor_id, actor_role, subject_entity
    FROM events
    WHERE event_type = ${eventType}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: payloadOf(row.payload),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subjectEntity: row.subject_entity,
  }));
}

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
      refuse: () => undefined,
    },
  };
}

describe('экран участников', () => {
  it('R-517 строка настроек — участники', () => {
    const text = renderParticipants({ projectName: 'Альфа', candidates: [], members: [] });
    expect(text.startsWith(`${PARTICIPANTS_HEADING}\n`)).toBe(true);
    expect(parseParticipantsMessage(`${PARTICIPANTS_HEADING}\nАльфа`)).toEqual({ projectName: 'Альфа' });
    expect(parseParticipantsMessage('Новый проект\nАльфа\n\nEurope/Moscow')).toBeNull();
  });

  it('R-590 корень видит людей, которые нажали /start и ещё не в проекте', () => {
    const text = renderParticipants({
      projectName: 'Альфа',
      candidates: [{ name: 'Борис' }, { name: 'Вера' }],
      members: [{ name: 'Глеб', role: MEMBER_ROLE }],
    });
    const waiting = text.split(PARTICIPANTS_IN_PROJECT)[0] ?? '';
    expect(waiting).toContain(PARTICIPANTS_NOT_IN_PROJECT);
    expect(waiting).toContain('Борис');
    expect(waiting).toContain('Вера');
    expect(waiting).not.toContain('Глеб');
  });

  it('R-591 строка добавления называет роль member', () => {
    expect(addedReply('Борис', 'Альфа')).toContain('Борис добавлен как member.');
  });

  it('R-251 перед удалением текст говорит, что незакрытые задачи снимают', () => {
    expect(removeConfirmText('Борис')).toBe('Удалить из проекта: Борис. Незакрытые задачи будут сняты.');
    expect(removedReply('Борис')).toBe('Борис удалён из проекта.');
  });

  it('роль одного человека рисуется отдельно в каждом проекте', () => {
    const alpha = renderParticipants({
      projectName: 'Альфа',
      candidates: [],
      members: [{ name: 'Борис', role: MEMBER_ROLE }],
    });
    const beta = renderParticipants({
      projectName: 'Бета',
      candidates: [],
      members: [{ name: 'Борис', role: LEAD_ROLE }],
    });
    expect(alpha).toContain('Борис — member');
    expect(beta).toContain('Борис — lead');
    expect(alpha).not.toContain('lead');
  });
});

describe('INV-16 состав видит только корень', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-16 человек вне проекта не видит состав и чужие имена', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    const reply = await replyToParticipantsMessage('private', borisAccount, { projectName: 'Альфа' }, membership);
    expect(reply?.text).toBe(PARTICIPANTS_ACCESS);
    expect(reply?.text).not.toContain('Альфа');
    expect(reply?.text).not.toContain('Вера');
    expect(reply?.text).not.toContain('Аня');
    expectMembership(fixture, await membersOf(fixture.db));

    const added = await replyToAddMember('private', borisAccount, fixture.alphaId, String(veraAccount.id), 'outsider-add', membership);
    expect(added?.text).toBe(PARTICIPANTS_ACCESS);
    expectMembership(fixture, await membersOf(fixture.db));
    expect(await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_ADDED)).toEqual([]);
  });

  it('INV-16 участник, который не корень, состав не получает', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'add-boris-access', membership);
    const reply = await replyToParticipantsMessage('private', borisAccount, { projectName: 'Альфа' }, membership);
    expect(reply?.text).toBe(PARTICIPANTS_ROOT_ONLY);
    expect(reply?.text).not.toContain('Вера');
    expect(reply?.text).not.toContain('Альфа');
  });
});

describe('INV-18 добавление member и снятие незакрытых задач', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-18 корень добавляет человека как member, и тот ведёт задачи', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    const reply = await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'add-boris', membership);
    expect(reply?.text).toBe(addedReply('Борис', 'Альфа'));
    expect(leadsTasks(MEMBER_ROLE)).toBe(true);
    expectMembership(fixture, await membersOf(fixture.db), [
      { projectId: fixture.alphaId, userId: fixture.borisId, role: MEMBER_ROLE },
    ]);
    const events = await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_ADDED);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotencyKey: 'add-boris',
      actorId: fixture.rootId,
      actorRole: MEMBERSHIP_ACTOR_ROLE,
      subjectEntity: 'ProjectMember',
      payload: { project_id: fixture.alphaId, user_id: fixture.borisId, role: MEMBER_ROLE },
    });
  });

  it('INV-18 один человек в двух проектах, роль в каждом своя', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES (${memberId}::uuid, ${fixture.betaId}::uuid, ${fixture.borisId}::uuid, ${LEAD_ROLE})
    `.execute(fixture.db);
    const reply = await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'add-boris-alpha', membership);
    expect(reply?.text).toBe(addedReply('Борис', 'Альфа'));
    expectMembership(fixture, await membersOf(fixture.db), [
      { projectId: fixture.alphaId, userId: fixture.borisId, role: MEMBER_ROLE },
      { projectId: fixture.betaId, userId: fixture.borisId, role: LEAD_ROLE },
    ]);
    const screen = await replyToParticipantsMessage('private', rootAccount, { projectName: 'Альфа' }, membership);
    expect(screen?.text).toContain('Борис — member');
    expect(screen?.text).not.toContain('Борис — lead');
    const beta = await replyToParticipantsMessage('private', rootAccount, { projectName: 'Бета' }, membership);
    expect(beta?.text).toContain('Борис — lead');
    expect(beta?.text).not.toContain(PARTICIPANTS_NOT_IN_PROJECT + '\nБорис');
  });

  it('INV-18 удаление записывает незакрытые задачи в том же акте', async () => {
    const root: User = {
      id: '00000000-0000-4000-8000-000000000001',
      telegramUserId: '1001',
      githubLogin: null,
      name: 'Аня',
      isRoot: true,
    };
    const boris: User = { id: borisId, telegramUserId: '1002', githubLogin: null, name: 'Борис', isRoot: false };
    const member: ProjectMemberView = {
      id: memberId,
      projectId: projectAlpha,
      userId: borisId,
      role: MEMBER_ROLE,
      name: 'Борис',
      telegramUserId: '1002',
    };
    const deleted: string[] = [];
    let present = true;
    const store: MembershipStore = {
      async hasMembership() {
        return false;
      },
      async projectsNamed() {
        return [];
      },
      async projectExists() {
        return true;
      },
      async candidates() {
        return [];
      },
      async members() {
        return [];
      },
      async findMember() {
        return present ? member : null;
      },
      async insert() {
        return undefined;
      },
      async deleteMember(id) {
        deleted.push(id);
        present = false;
      },
      async unclosedTaskIds(projectId, userId) {
        expect(projectId).toBe(projectAlpha);
        expect(userId).toBe(borisId);
        return [taskOne, taskTwo];
      },
    };
    const journal = memoryJournal();
    const ids = await removeProjectMember(store, journal.journal, clock, {
      actor: root,
      chat: 'private',
      projectId: projectAlpha,
      target: boris,
      idempotencyKey: 'rm-tasks',
    });
    expect(ids).toEqual([taskOne, taskTwo]);
    expect(deleted).toEqual([memberId]);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0]?.payload).toEqual({
      project_id: projectAlpha,
      user_id: borisId,
      cancelled_task_ids: [taskOne, taskTwo],
    });
    await expect(
      removeProjectMember(store, journal.journal, clock, {
        actor: root,
        chat: 'private',
        projectId: projectAlpha,
        target: boris,
        idempotencyKey: 'rm-tasks-again',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.MEMBER_ABSENT });
    expect(journal.rows).toHaveLength(1);
  });

  it('INV-18 снятие и событие коммитятся вместе: повтор ключа оставляет участника', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'add-before-rollback', membership);
    await sql`
      INSERT INTO events (
        id, source, event_type, payload, created_at, idempotency_key,
        causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id
      ) VALUES (
        '00000000-0000-4000-8000-00000000e001'::uuid,
        'telegram',
        ${EVENT_TYPES.PROJECT_MEMBER_REMOVED},
        ${JSON.stringify({ project_id: fixture.alphaId, user_id: fixture.borisId, cancelled_task_ids: [] })}::jsonb,
        ${clock.now().toISOString()}::timestamptz,
        'rm-dup',
        NULL,
        NULL,
        1,
        'seed',
        'root',
        'ProjectMember',
        'seed-member'
      )
    `.execute(fixture.db);
    const reply = await replyToConfirmRemoval(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'rm-dup',
      membership,
    );
    expect(reply).toBeNull();
    expectMembership(fixture, await membersOf(fixture.db), [
      { projectId: fixture.alphaId, userId: fixture.borisId, role: MEMBER_ROLE },
    ]);
    const events = await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_REMOVED);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe('seed');
  });
});

describe('INV-19 участников меняет корень в личке', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 корень в личке видит тех, кто ещё не в проекте, и добавляет их', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    const screen = await replyToParticipantsMessage('private', rootAccount, { projectName: 'Альфа' }, membership);
    expect(screen?.text.startsWith(`${PARTICIPANTS_HEADING}\nАльфа\n`)).toBe(true);
    expect(screen?.text).toContain('Борис');
    expect(screen?.text).toContain('Вера');
    const waiting = screen?.text.split(PARTICIPANTS_IN_PROJECT)[0] ?? '';
    expect(waiting).not.toContain('Аня');
    expect(screen?.text).toContain('Аня — lead');
    expect(screen?.markup).toBeDefined();

    const outside = await replyToParticipantsMessage('supergroup', rootAccount, { projectName: 'Альфа' }, membership);
    expect(outside).toBeNull();
    expectMembership(fixture, await membersOf(fixture.db));

    const missing = await replyToParticipantsMessage('private', rootAccount, { projectName: 'Нет такого' }, membership);
    expect(missing?.text).toBe(PARTICIPANTS_NO_PROJECT);
    expect(missing?.text).not.toContain('Вера');
  });

  it('INV-19 удаление требует подтверждения и снимает только после него', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'add-for-remove', membership);
    const ask = await replyToRemovalRequest('private', rootAccount, fixture.alphaId, String(borisAccount.id), membership);
    expect(ask?.text).toBe(removeConfirmText('Борис'));
    expectMembership(fixture, await membersOf(fixture.db), [
      { projectId: fixture.alphaId, userId: fixture.borisId, role: MEMBER_ROLE },
    ]);
    expect(await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_REMOVED)).toEqual([]);

    const removed = await replyToConfirmRemoval('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'rm-boris', membership);
    expect(removed?.text).toBe(removedReply('Борис'));
    expectMembership(fixture, await membersOf(fixture.db));
    const events = await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_REMOVED);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotencyKey: 'rm-boris',
      actorId: fixture.rootId,
      actorRole: MEMBERSHIP_ACTOR_ROLE,
      payload: { project_id: fixture.alphaId, user_id: fixture.borisId, cancelled_task_ids: [] },
    });
    const again = await replyToConfirmRemoval('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'rm-boris-2', membership);
    expect(again?.text).toBe(PARTICIPANTS_ABSENT);
    expect(await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_REMOVED)).toHaveLength(1);
  });
});

describe('INV-22 повтор добавления и удаления не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не добавляет второго человека и не пишет второе событие', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    const first = await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'same-add', membership);
    const second = await replyToAddMember('private', rootAccount, fixture.alphaId, String(veraAccount.id), 'same-add', membership);
    expect(first?.text).toBe(addedReply('Борис', 'Альфа'));
    expect(second).toBeNull();
    expectMembership(fixture, await membersOf(fixture.db), [
      { projectId: fixture.alphaId, userId: fixture.borisId, role: MEMBER_ROLE },
    ]);
    expect(await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_ADDED)).toHaveLength(1);

    const duplicatePerson = await replyToAddMember('private', rootAccount, fixture.alphaId, String(borisAccount.id), 'other-add', membership);
    expect(duplicatePerson?.text).toBe('Уже в проекте.');
    expect(await eventsOf(fixture.db, EVENT_TYPES.PROJECT_MEMBER_ADDED)).toHaveLength(1);
  });

  it('INV-22 пустой ключ участника не записывает', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await expect(
      membership.add({
        telegramUserId: String(rootAccount.id),
        projectId: fixture.alphaId,
        targetTelegramUserId: String(borisAccount.id),
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      membership.add({
        telegramUserId: String(rootAccount.id),
        projectId: fixture.alphaId,
        targetTelegramUserId: String(borisAccount.id),
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.MEMBER_IDEMPOTENCY_KEY });
    expectMembership(fixture, await membersOf(fixture.db));
  });
});

describe('кнопки состава', () => {
  it('данные кнопки разбираются обратно в проект и человека', () => {
    const add = `ma:${projectAlpha}:${borisAccount.id}`;
    const remove = `md:${projectBeta}:${veraAccount.id}`;
    const confirm = `mc:${projectAlpha}:${borisAccount.id}`;
    expect(parseMemberCallback(add)).toEqual({ action: 'add', projectId: projectAlpha, telegramUserId: String(borisAccount.id) });
    expect(parseMemberCallback(remove)).toEqual({
      action: 'remove',
      projectId: projectBeta,
      telegramUserId: String(veraAccount.id),
    });
    expect(parseMemberCallback(confirm)?.action).toBe('confirm');
    expect(parseMemberCallback('b:not-a-member')).toBeNull();
    expect(add.length).toBeLessThanOrEqual(64);
    expect(confirm.length).toBeLessThanOrEqual(64);
  });
});
