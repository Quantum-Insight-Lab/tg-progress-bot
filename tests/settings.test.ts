import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import { memberRoleValue, SETTINGS_ACTOR_ROLE } from '../src/domain/projects/settings.ts';
import { projectCalendarDate, projectDaysBetween, staleByProjectZone } from '../src/domain/shared/project-time.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { STALE_DAYS } from '../src/config/constants.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readCanvasesMigration,
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createProjectSettings } from '../src/infrastructure/settings.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import {
  parseSettingsMessage,
  renderSettings,
  replyToSettings,
  SETTINGS_ACCESS,
  SETTINGS_AMBIGUOUS,
  SETTINGS_BAD_ZONE,
  SETTINGS_CHAT_UNKNOWN,
  SETTINGS_HEADING,
  SETTINGS_HINT,
  SETTINGS_MEMBER_ABSENT,
  SETTINGS_NEED_NAME,
  SETTINGS_NOT_SUPERGROUP,
  SETTINGS_NO_PROJECT,
  SETTINGS_ROLE,
  SETTINGS_ROLE_SHAPE,
  SETTINGS_ROOT_ONLY,
  SETTINGS_UNBOUND,
  SETTINGS_UNKNOWN_FIELD,
} from '../src/telegram/settings.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const glebAccount = { id: 1004, is_bot: false, first_name: 'Глеб' };
const telegramChatId = '-1001234567890';
const otherChatId = '-1009876543210';
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
  betaId: string;
  borisId: string;
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
  await pglite.exec(readCanvasesMigration());
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
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
  await registration.registerOnStart({ telegramUserId: String(glebAccount.id), name: glebAccount.first_name });
  const creation = createProjectCreation(handle.db, silentLogger, clock);
  const alpha = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: 'первый',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  const beta = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Бета',
    description: '',
    timezone: 'Asia/Yekaterinburg',
    chat: 'private',
    idempotencyKey: 'project-beta',
  });
  const membership = createMembership(handle.db, silentLogger, clock);
  await membership.add({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris',
  });
  await membership.add({
    telegramUserId: String(rootAccount.id),
    projectId: beta.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris-beta',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (${leadId}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE})
  `.execute(handle.db);
  const binding = createChatBinding(handle.db, silentLogger, clock);
  await binding.confirm({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    offer: forumAdmin,
    idempotencyKey: 'bind-alpha',
  });
  await binding.confirm({
    telegramUserId: String(rootAccount.id),
    projectId: beta.project.id,
    offer: { ...forumAdmin, telegramChatId: otherChatId },
    idempotencyKey: 'bind-beta',
  });
  return { db: handle.db, close: handle.close, alphaId: alpha.project.id, betaId: beta.project.id, borisId: boris.user.id };
}

interface StoredProject {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chatId: string | null;
}

async function projects(db: Kysely<Database>): Promise<StoredProject[]> {
  const result = await sql<{ id: string; name: string; description: string; timezone: string; chat_id: string | null }>`
    SELECT id::text AS id, name, description, timezone, chat_id::text AS chat_id FROM projects ORDER BY name
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
    chatId: row.chat_id,
  }));
}

async function roles(db: Kysely<Database>, projectId: string): Promise<{ name: string; role: string }[]> {
  const result = await sql<{ name: string; role: string }>`
    SELECT users.name, project_members.role
    FROM project_members
    JOIN users ON users.id = project_members.user_id
    WHERE project_members.project_id = ${projectId}::uuid
    ORDER BY users.name
  `.execute(db);
  return result.rows.map((row) => ({ name: row.name, role: row.role }));
}

async function chatZones(db: Kysely<Database>): Promise<{ telegramChatId: string; timezone: string }[]> {
  const result = await sql<{ telegram_chat_id: string; timezone: string }>`
    SELECT telegram_chat_id::text AS telegram_chat_id, timezone FROM chats ORDER BY telegram_chat_id
  `.execute(db);
  return result.rows.map((row) => ({ telegramChatId: row.telegram_chat_id, timezone: row.timezone }));
}

async function settingsEvents(db: Kysely<Database>): Promise<{ idempotencyKey: string; actorRole: string; subjectId: string; payload: unknown }[]> {
  const result = await sql<{ idempotency_key: string; actor_role: string; subject_id: string; payload: unknown }>`
    SELECT idempotency_key, actor_role, subject_id::text AS subject_id, payload
    FROM events
    WHERE event_type = ${EVENT_TYPES.PROJECT_SETTINGS_CHANGED}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    actorRole: row.actor_role,
    subjectId: row.subject_id,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

async function canvasEvents(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT CAST(count(*) AS int) AS n FROM events
    WHERE event_type IN (
      ${EVENT_TYPES.CANVAS_POSTED},
      ${EVENT_TYPES.CANVAS_EDITED},
      ${EVENT_TYPES.CANVAS_FULL},
      ${EVENT_TYPES.CANVAS_CARRIED_OVER}
    )
  `.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('разбор админки', () => {
  it('сообщение настроек — заголовок, проект и одно поле', () => {
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа`)).toEqual({ kind: 'show', projectName: 'Альфа' });
    expect(parseSettingsMessage('Участники\nАльфа')).toBeNull();
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nимя`)).toEqual({ kind: 'hint' });
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nцвет\nсиний`)).toEqual({ kind: 'unknown-field' });
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nроль\nlead`)).toEqual({ kind: 'role-shape' });
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nимя\nГамма`)).toEqual({
      kind: 'change',
      projectName: 'Альфа',
      update: { field: 'name', value: 'Гамма' },
    });
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nописание\n`)).toEqual({
      kind: 'change',
      projectName: 'Альфа',
      update: { field: 'description', value: '' },
    });
    expect(parseSettingsMessage(`${SETTINGS_HEADING}\nАльфа\nроль\nБорис Петров lead`)).toEqual({
      kind: 'change',
      projectName: 'Альфа',
      update: { field: 'member_role', memberName: 'Борис Петров', role: 'lead' },
    });
    const screen = renderSettings({
      name: 'Альфа',
      description: 'первый',
      timezone: 'Europe/Moscow',
      telegramChatId: null,
      members: [{ name: 'Борис', role: MEMBER_ROLE }],
    });
    expect(screen.startsWith(SETTINGS_HEADING)).toBe(true);
    expect(screen).toContain('Имя: Альфа');
    expect(screen).toContain('Описание: первый');
    expect(screen).toContain('Таймзона проекта: Europe/Moscow');
    expect(screen).toContain(`Супергруппа: ${SETTINGS_UNBOUND}`);
    expect(screen).toContain(`Борис — ${MEMBER_ROLE}`);
  });
});

describe('INV-19 настройки меняет только корень в личке', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 корень в личке меняет имя, описание, таймзону, супергруппу и роль; остальные нет', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createProjectSettings(fixture.db, silentLogger, clock);
    const before = await projects(fixture.db);
    const alpha = before.find((project) => project.name === 'Альфа');
    const beta = before.find((project) => project.name === 'Бета');
    if (alpha === undefined || beta === undefined || alpha.chatId === null || beta.chatId === null) throw new Error('нет проектов');

    const shown = await replyToSettings('private', rootAccount, { kind: 'show', projectName: 'Альфа' }, 'show', actions);
    expect(shown).toContain('Имя: Альфа');
    expect(shown).toContain('Описание: первый');
    expect(shown).toContain('Таймзона проекта: Europe/Moscow');
    expect(shown).toContain(`Супергруппа: ${telegramChatId}`);
    expect(shown).toContain(`Борис — ${MEMBER_ROLE}`);
    expect(shown).toContain(`Вера — ${LEAD_ROLE}`);

    const outside = await replyToSettings(
      'supergroup',
      rootAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'name', value: 'Гамма' } },
      'group',
      actions,
    );
    expect(outside).toBeNull();

    const member = await replyToSettings(
      'private',
      borisAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'name', value: 'Гамма' } },
      'member',
      actions,
    );
    expect(member).toBe(SETTINGS_ROOT_ONLY);
    const lead = await replyToSettings(
      'private',
      veraAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'description', value: 'чужое' } },
      'lead',
      actions,
    );
    expect(lead).toBe(SETTINGS_ROOT_ONLY);
    const stranger = await replyToSettings(
      'private',
      glebAccount,
      { kind: 'show', projectName: 'Альфа' },
      'stranger',
      actions,
    );
    expect(stranger).toBe(SETTINGS_ACCESS);
    expect(await projects(fixture.db)).toEqual(before);

    const renamed = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'name', value: '  Гамма  ' } },
      'rename',
      actions,
    );
    expect(renamed).toContain('Имя: Гамма');
    const described = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Гамма', update: { field: 'description', value: '  второе  ' } },
      'describe',
      actions,
    );
    expect(described).toContain('Описание: второе');
    const zoned = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Гамма', update: { field: 'timezone', value: ' Asia/Tokyo ' } },
      'zone',
      actions,
    );
    expect(zoned).toContain('Таймзона проекта: Asia/Tokyo');
    const moved = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Гамма', update: { field: 'chat', telegramChatId: otherChatId } },
      'chat',
      actions,
    );
    expect(moved).toContain(`Супергруппа: ${otherChatId}`);
    const promoted = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Гамма', update: { field: 'member_role', memberName: 'Борис', role: LEAD_ROLE } },
      'role',
      actions,
    );
    expect(promoted).toContain(`Борис — ${LEAD_ROLE}`);
    expect(promoted).toContain(`Вера — ${LEAD_ROLE}`);

    const after = await projects(fixture.db);
    expect(after.find((project) => project.id === alpha.id)).toEqual({
      id: alpha.id,
      name: 'Гамма',
      description: 'второе',
      timezone: 'Asia/Tokyo',
      chatId: beta.chatId,
    });
    expect(after.find((project) => project.id === beta.id)).toEqual(beta);
    expect(await roles(fixture.db, alpha.id)).toEqual([
      { name: 'Аня', role: LEAD_ROLE },
      { name: 'Борис', role: LEAD_ROLE },
      { name: 'Вера', role: LEAD_ROLE },
    ]);
    expect(await roles(fixture.db, beta.id)).toEqual([
      { name: 'Аня', role: LEAD_ROLE },
      { name: 'Борис', role: MEMBER_ROLE },
    ]);
    expect(await settingsEvents(fixture.db)).toEqual([
      {
        idempotencyKey: 'chat',
        actorRole: SETTINGS_ACTOR_ROLE,
        subjectId: alpha.id,
        payload: { project_id: alpha.id, field: 'chat', value: beta.chatId },
      },
      {
        idempotencyKey: 'describe',
        actorRole: SETTINGS_ACTOR_ROLE,
        subjectId: alpha.id,
        payload: { project_id: alpha.id, field: 'description', value: 'второе' },
      },
      {
        idempotencyKey: 'rename',
        actorRole: SETTINGS_ACTOR_ROLE,
        subjectId: alpha.id,
        payload: { project_id: alpha.id, field: 'name', value: 'Гамма' },
      },
      {
        idempotencyKey: 'role',
        actorRole: SETTINGS_ACTOR_ROLE,
        subjectId: alpha.id,
        payload: { project_id: alpha.id, field: 'member_role', value: memberRoleValue(fixture.borisId, LEAD_ROLE) },
      },
      {
        idempotencyKey: 'zone',
        actorRole: SETTINGS_ACTOR_ROLE,
        subjectId: alpha.id,
        payload: { project_id: alpha.id, field: 'timezone', value: 'Asia/Tokyo' },
      },
    ]);

    expect(await replyToSettings('private', rootAccount, { kind: 'show', projectName: 'Нет такого' }, 'missing', actions)).toBe(
      SETTINGS_NO_PROJECT,
    );
    await createProjectCreation(fixture.db, silentLogger, clock).create({
      telegramUserId: String(rootAccount.id),
      name: 'Бета',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-beta-2',
    });
    expect(await replyToSettings('private', rootAccount, { kind: 'show', projectName: 'Бета' }, 'ambiguous', actions)).toBe(
      SETTINGS_AMBIGUOUS,
    );
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'name', value: '   ' } },
        'blank-name',
        actions,
      ),
    ).toBe(SETTINGS_NEED_NAME);
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'timezone', value: 'Не/Зона' } },
        'bad-zone',
        actions,
      ),
    ).toBe(SETTINGS_BAD_ZONE);
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'chat', telegramChatId: '-100111' } },
        'unknown-chat',
        actions,
      ),
    ).toBe(SETTINGS_CHAT_UNKNOWN);
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'chat', telegramChatId: '15' } },
        'topic',
        actions,
      ),
    ).toBe(SETTINGS_NOT_SUPERGROUP);
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'member_role', memberName: 'Глеб', role: MEMBER_ROLE } },
        'absent',
        actions,
      ),
    ).toBe(SETTINGS_MEMBER_ABSENT);
    expect(
      await replyToSettings(
        'private',
        rootAccount,
        { kind: 'change', projectName: 'Гамма', update: { field: 'member_role', memberName: 'Борис', role: 'viewer' } },
        'viewer',
        actions,
      ),
    ).toBe(SETTINGS_ROLE);
    expect(await replyToSettings('private', rootAccount, { kind: 'hint' }, 'hint', actions)).toBe(SETTINGS_HINT);
    expect(await replyToSettings('private', rootAccount, { kind: 'unknown-field' }, 'field', actions)).toBe(SETTINGS_UNKNOWN_FIELD);
    expect(await replyToSettings('private', rootAccount, { kind: 'role-shape' }, 'shape', actions)).toBe(SETTINGS_ROLE_SHAPE);
    expect((await projects(fixture.db)).find((project) => project.id === alpha.id)?.timezone).toBe('Asia/Tokyo');
  });
});

describe('INV-22 повтор настройки не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не меняет поле и не пишет второе событие', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createProjectSettings(fixture.db, silentLogger, clock);
    const first = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'description', value: 'записано' } },
      'once',
      actions,
    );
    expect(first).toContain('Описание: записано');
    const again = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'description', value: 'другое' } },
      'once',
      actions,
    );
    expect(again).toBeNull();
    const stored = await projects(fixture.db);
    expect(stored.find((project) => project.id === fixture.alphaId)?.description).toBe('записано');
    expect(await settingsEvents(fixture.db)).toHaveLength(1);
    await expect(
      actions.change({
        telegramUserId: String(rootAccount.id),
        projectName: 'Альфа',
        chat: 'private',
        update: { field: 'name', value: 'Гамма' },
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.SETTINGS_IDEMPOTENCY_KEY });
    expect(stored.find((project) => project.id === fixture.alphaId)?.name).toBe('Альфа');
    expect(await settingsEvents(fixture.db)).toHaveLength(1);
  });
});

describe('INV-24 сутки и застой по таймзоне проекта, канвас не переписывается', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-24 смена таймзоны не переписывает канвас; новые сутки и новый застой считаются по новой зоне', async () => {
    const earlier = new Date('2026-09-27T20:00:00.000Z');
    const later = new Date('2026-09-28T22:00:00.000Z');
    const sentCanvasDate = projectCalendarDate(later, 'Europe/Moscow');
    expect(sentCanvasDate).toBe('2026-09-29');
    expect(projectCalendarDate(later, 'Etc/UTC')).toBe('2026-09-28');
    expect(projectDaysBetween(earlier, later, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(projectDaysBetween(earlier, later, 'Etc/UTC')).toBe(STALE_DAYS - 1);
    expect(staleByProjectZone(earlier, later, 'Europe/Moscow')).toBe(true);
    expect(staleByProjectZone(earlier, later, 'Etc/UTC')).toBe(false);

    const fixture = await seed();
    opened.push(fixture);
    const canvasId = '00000000-0000-4000-8000-0000000000c1';
    await sql`
      INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
      VALUES (
        ${canvasId}::uuid,
        ${fixture.alphaId}::uuid,
        ${fixture.borisId}::uuid,
        42,
        900,
        ${sentCanvasDate}::date
      )
    `.execute(fixture.db);
    const actions = createProjectSettings(fixture.db, silentLogger, clock);
    const beforeProjects = await projects(fixture.db);
    const beforeChats = await chatZones(fixture.db);
    const beforeRoles = await roles(fixture.db, fixture.alphaId);
    const topics = await sql<{ topic_id: string | null }>`
      SELECT topic_id FROM project_members WHERE project_id = ${fixture.alphaId}::uuid ORDER BY topic_id NULLS FIRST
    `.execute(fixture.db);

    const changed = await replyToSettings(
      'private',
      rootAccount,
      { kind: 'change', projectName: 'Альфа', update: { field: 'timezone', value: 'Etc/UTC' } },
      'zone-utc',
      actions,
    );
    expect(changed).toContain('Таймзона проекта: Etc/UTC');
    const alpha = (await projects(fixture.db)).find((project) => project.id === fixture.alphaId);
    const previous = beforeProjects.find((project) => project.id === fixture.alphaId);
    if (alpha === undefined || previous === undefined) throw new Error('нет Альфы');
    expect(alpha.timezone).toBe('Etc/UTC');
    expect(alpha.name).toBe(previous.name);
    expect(alpha.description).toBe(previous.description);
    expect(alpha.chatId).toBe(previous.chatId);
    expect(await chatZones(fixture.db)).toEqual(beforeChats);
    expect(await roles(fixture.db, fixture.alphaId)).toEqual(beforeRoles);
    const topicsAfter = await sql<{ topic_id: string | null }>`
      SELECT topic_id FROM project_members WHERE project_id = ${fixture.alphaId}::uuid ORDER BY topic_id NULLS FIRST
    `.execute(fixture.db);
    expect(topicsAfter.rows).toEqual(topics.rows);
    expect(await canvasEvents(fixture.db)).toBe(0);
    expect(projectCalendarDate(later, alpha.timezone)).toBe('2026-09-28');
    expect(projectCalendarDate(later, alpha.timezone)).not.toBe(sentCanvasDate);
    expect(staleByProjectZone(earlier, later, alpha.timezone)).toBe(false);
    expect(staleByProjectZone(earlier, later, 'Europe/Moscow')).toBe(true);
    const storedCanvas = await sql<{ topic_id: string; message_id: string; canvas_date: string }>`
      SELECT topic_id::text AS topic_id, message_id::text AS message_id, canvas_date::text AS canvas_date
      FROM canvases
    `.execute(fixture.db);
    expect(storedCanvas.rows).toEqual([{ topic_id: '42', message_id: '900', canvas_date: sentCanvasDate }]);
  });
});
