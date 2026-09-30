import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import {
  ABSENT_BLOCKER_MIRROR_FIELDS,
  closeBlocker,
  defineBlocker,
  isOpenBlocker,
  type Blocker,
} from '../src/domain/tasks/blocker.ts';
import { TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  type TaskStatus,
} from '../src/domain/tasks/status.ts';
import {
  TASK_TRANSITION_CANCEL,
  TASK_TRANSITION_CHECK,
  TASK_TRANSITION_CONFIRM,
  TASK_TRANSITION_PLAN,
  closesBlockerOnExit,
  transitionTask,
} from '../src/domain/tasks/transition.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readBlockersMigration,
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import {
  cancelRemovedMemberTasks,
  createTaskActions,
  createTaskCancelActions,
  createTaskMarkActions,
  createTaskPlanActions,
  createTaskReviewActions,
} from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const at = '2026-09-28T07:33:00.000Z';
const askedAt = '2026-09-26T07:33:00.000Z';

const projectId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-0000000000b1';
const otherTaskId = '00000000-0000-4000-8000-0000000000b2';

const openRow: Blocker = {
  id: '00000000-0000-4000-8000-0000000000e1',
  taskId,
  reason: 'нет доступа к стенду',
  askedAt,
  resolvedAt: null,
};

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const borisTopic = 17;
const veraTopic = 18;

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
}

async function openSchema(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
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

async function seedSchema(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${userId}::uuid, 1001, 'Аня', true)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, ${at}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
    VALUES
      (${taskId}::uuid, ${projectId}::uuid, 7, 'Ждёт', ${TASK_STATUS_BLOCKED}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${otherTaskId}::uuid, ${projectId}::uuid, 8, 'Рядом', ${TASK_STATUS_BLOCKED}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz)
  `.execute(db);
}

async function insertBlocker(db: Kysely<Database>, blocker: Blocker): Promise<void> {
  const row = defineBlocker(blocker);
  await sql`
    INSERT INTO blockers (id, task_id, reason, asked_at, resolved_at)
    VALUES (
      ${row.id}::uuid,
      ${row.taskId}::uuid,
      ${row.reason},
      ${row.askedAt}::timestamptz,
      ${row.resolvedAt}::timestamptz
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'blockers'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

async function storedBlocker(db: Kysely<Database>, id: string): Promise<{ reason: string | null; resolvedAt: string | null; taskId: string }> {
  const result = await sql<{ reason: string | null; resolved_at: Date | string | null; task_id: string }>`
    SELECT reason, resolved_at, task_id::text AS task_id
    FROM blockers
    WHERE id = ${id}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('блокера нет');
  return { reason: row.reason, resolvedAt: stamp(row.resolved_at), taskId: row.task_id };
}

async function openProject(): Promise<Fixture> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
  const registration = createUserRegistration(db, silentLogger, clock);
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
  const alpha = await createProjectCreation(db, silentLogger, clock).create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  await createMembership(db, silentLogger, clock).add({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES (${'00000000-0000-4000-8000-0000000000c1'}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE}, ${veraTopic})
  `.execute(db);
  await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid`.execute(db);
  await createChatBinding(db, silentLogger, clock).confirm({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    offer: forumAdmin,
    idempotencyKey: 'bind-alpha',
  });
  return {
    db,
    async close() {
      await db.destroy();
    },
    alphaId: alpha.project.id,
    borisId: boris.user.id,
  };
}

async function setStatus(db: Kysely<Database>, id: string, status: TaskStatus): Promise<void> {
  await sql`UPDATE tasks SET status = ${status} WHERE id = ${id}::uuid`.execute(db);
}

const place = {
  telegramUserId: String(borisAccount.id),
  chat: TASK_TOPIC_CHAT,
  telegramChatId,
  topicId: borisTopic,
};

describe('блокер задачи', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-11 причина — ответ исполнителя; блокер только у задачи, строки CI и PR не пишутся', async () => {
    const blocker = defineBlocker(openRow);
    expect(blocker).toEqual(openRow);
    expect(isOpenBlocker(blocker)).toBe(true);
    expect(defineBlocker({ ...openRow, reason: null }).reason).toBeNull();
    expect(defineBlocker({ ...openRow, reason: '  ждём ключ  ' }).reason).toBe('ждём ключ');

    expect(() => defineBlocker({ ...openRow, id: ' ' })).toThrow(DomainError);
    expect(() => defineBlocker({ ...openRow, id: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_ID_BLANK }));
    expect(() => defineBlocker({ ...openRow, taskId: '' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_TASK_BLANK }));
    expect(() => defineBlocker({ ...openRow, reason: '   ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_REASON }));
    expect(() => defineBlocker({ ...openRow, askedAt: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_ASKED_AT }));
    expect(() => defineBlocker({ ...openRow, resolvedAt: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_RESOLVED_AT }));
    for (const field of ABSENT_BLOCKER_MIRROR_FIELDS) {
      const withMirror = { ...openRow, [field]: 'красный' };
      expect(() => defineBlocker(withMirror)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_NOT_TASK }));
    }

    const closed = closeBlocker(blocker, at);
    expect(closed.resolvedAt).toBe(at);
    expect(closed.reason).toBe(openRow.reason);
    expect(isOpenBlocker(closed)).toBe(false);
    expect(closeBlocker(closed, '2026-09-29T07:33:00.000Z').resolvedAt).toBe(at);
    expect(() => closeBlocker(blocker, ' ')).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_RESOLVED_AT }));

    const handle = await openSchema();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual(['asked_at', 'id', 'reason', 'resolved_at', 'task_id']);
    await seedSchema(handle.db);
    await insertBlocker(handle.db, blocker);
    await insertBlocker(handle.db, defineBlocker({ ...openRow, id: '00000000-0000-4000-8000-0000000000e2', taskId: otherTaskId, reason: null }));
    expect(await storedBlocker(handle.db, blocker.id)).toEqual({
      reason: openRow.reason,
      resolvedAt: null,
      taskId,
    });

    await expect(insertBlocker(handle.db, blocker)).rejects.toThrow(/duplicate key|23505|blockers_pkey/);
    await expect(
      sql`
        INSERT INTO blockers (id, reason, asked_at)
        VALUES (${'00000000-0000-4000-8000-0000000000e3'}::uuid, 'ответ', ${askedAt}::timestamptz)
      `.execute(handle.db),
    ).rejects.toThrow(/task_id|null value|23502/);
    await expect(
      sql`
        INSERT INTO blockers (id, task_id, reason, asked_at)
        VALUES (
          ${'00000000-0000-4000-8000-0000000000e4'}::uuid,
          ${'00000000-0000-4000-8000-000000000099'}::uuid,
          'ответ',
          ${askedAt}::timestamptz
        )
      `.execute(handle.db),
    ).rejects.toThrow(/blockers_task_id_fkey|23503/);
    await expect(
      sql`
        INSERT INTO blockers (id, task_id, reason, asked_at)
        VALUES (${'00000000-0000-4000-8000-0000000000e5'}::uuid, ${taskId}::uuid, '   ', ${askedAt}::timestamptz)
      `.execute(handle.db),
    ).rejects.toThrow(/blockers_reason_answer|23514/);
    await expect(
      sql`
        INSERT INTO blockers (id, task_id, asked_at, ci_status)
        VALUES (${'00000000-0000-4000-8000-0000000000e6'}::uuid, ${taskId}::uuid, ${askedAt}::timestamptz, 'failure')
      `.execute(handle.db),
    ).rejects.toThrow(/ci_status/);
    await expect(
      sql`
        INSERT INTO blockers (id, task_id, asked_at, pull_request_id)
        VALUES (${'00000000-0000-4000-8000-0000000000e7'}::uuid, ${taskId}::uuid, ${askedAt}::timestamptz, '1')
      `.execute(handle.db),
    ).rejects.toThrow(/pull_request_id/);
  });

  it('INV-11 блокер закрывается при любом выходе из BLOCKED; DONE только без открытого блокера', async () => {
    expect(closesBlockerOnExit(TASK_STATUS_BLOCKED, TASK_STATUS_REVIEW)).toBe(true);
    expect(closesBlockerOnExit(TASK_STATUS_BLOCKED, TASK_STATUS_PLANNED)).toBe(true);
    expect(closesBlockerOnExit(TASK_STATUS_BLOCKED, TASK_STATUS_CANCELLED)).toBe(true);
    expect(closesBlockerOnExit(TASK_STATUS_BLOCKED, TASK_STATUS_IN_PROGRESS)).toBe(true);
    expect(closesBlockerOnExit(TASK_STATUS_REVIEW, TASK_STATUS_DONE)).toBe(false);
    expect(closesBlockerOnExit(TASK_STATUS_IN_PROGRESS, TASK_STATUS_REVIEW)).toBe(false);
    expect(transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_CHECK).closesBlocker).toBe(closesBlockerOnExit(TASK_STATUS_BLOCKED, TASK_STATUS_REVIEW));
    expect(transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_PLAN).closesBlocker).toBe(true);
    expect(transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_CANCEL).closesBlocker).toBe(true);
    expect(() => transitionTask(TASK_STATUS_REVIEW, TASK_TRANSITION_CONFIRM, {
      role: LEAD_ROLE,
      actorId: 'lead',
      assigneeId: 'worker',
      leadCount: 1,
      openBlocker: true,
    })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_OPEN_BLOCKER }));

    const fixture = await openProject();
    opened.push(fixture);
    const tasks = createTaskActions(fixture.db, silentLogger, clock);
    const checked = await tasks.create({ ...place, title: 'Галочка', idempotencyKey: 'task-check' });
    const planned = await tasks.create({ ...place, title: 'План', idempotencyKey: 'task-plan' });
    const cancelled = await tasks.create({ ...place, title: 'Снять', idempotencyKey: 'task-cancel' });
    const removed = await tasks.create({ ...place, title: 'Уход', idempotencyKey: 'task-remove' });
    const held = await tasks.create({ ...place, title: 'Открыт', idempotencyKey: 'task-held' });
    const quiet = await tasks.create({ ...place, title: 'Не блок', idempotencyKey: 'task-quiet' });
    const past = await tasks.create({ ...place, title: 'Уже закрыт', idempotencyKey: 'task-past' });

    const ids = {
      check: '00000000-0000-4000-8000-0000000000f1',
      plan: '00000000-0000-4000-8000-0000000000f2',
      cancel: '00000000-0000-4000-8000-0000000000f3',
      remove: '00000000-0000-4000-8000-0000000000f4',
      held: '00000000-0000-4000-8000-0000000000f5',
      quiet: '00000000-0000-4000-8000-0000000000f6',
      past: '00000000-0000-4000-8000-0000000000f7',
      earlier: '2026-09-27T07:33:00.000Z',
    };

    await setStatus(fixture.db, checked.task.id, TASK_STATUS_BLOCKED);
    await setStatus(fixture.db, planned.task.id, TASK_STATUS_BLOCKED);
    await setStatus(fixture.db, cancelled.task.id, TASK_STATUS_BLOCKED);
    await setStatus(fixture.db, removed.task.id, TASK_STATUS_BLOCKED);
    await setStatus(fixture.db, held.task.id, TASK_STATUS_REVIEW);
    await insertBlocker(fixture.db, { ...openRow, id: ids.check, taskId: checked.task.id });
    await insertBlocker(fixture.db, { ...openRow, id: ids.plan, taskId: planned.task.id });
    await insertBlocker(fixture.db, { ...openRow, id: ids.cancel, taskId: cancelled.task.id });
    await insertBlocker(fixture.db, { ...openRow, id: ids.remove, taskId: removed.task.id });
    await insertBlocker(fixture.db, { ...openRow, id: ids.held, taskId: held.task.id });
    await insertBlocker(fixture.db, { ...openRow, id: ids.quiet, taskId: quiet.task.id });
    await insertBlocker(fixture.db, {
      ...openRow,
      id: ids.past,
      taskId: past.task.id,
      resolvedAt: ids.earlier,
    });

    const marked = await createTaskMarkActions(fixture.db, silentLogger, clock).press({
      ...place,
      taskNumber: checked.task.number,
      idempotencyKey: 'cb-check',
    });
    expect(marked.closesBlocker).toBe(true);
    expect(marked.task.status).toBe(TASK_STATUS_REVIEW);
    expect(await storedBlocker(fixture.db, ids.check)).toEqual({
      reason: openRow.reason,
      resolvedAt: at,
      taskId: checked.task.id,
    });

    const moved = await createTaskPlanActions(fixture.db, silentLogger, clock).press({
      ...place,
      taskNumber: planned.task.number,
      act: TASK_TRANSITION_PLAN,
      idempotencyKey: 'cb-plan',
    });
    expect(moved.closesBlocker).toBe(true);
    expect(moved.task.status).toBe(TASK_STATUS_PLANNED);
    expect((await storedBlocker(fixture.db, ids.plan)).resolvedAt).toBe(at);

    const dropped = await createTaskCancelActions(fixture.db, silentLogger, clock).press({
      ...place,
      taskNumber: cancelled.task.number,
      idempotencyKey: 'cb-cancel',
    });
    expect(dropped.closesBlocker).toBe(true);
    expect(dropped.task.status).toBe(TASK_STATUS_CANCELLED);
    expect((await storedBlocker(fixture.db, ids.cancel)).resolvedAt).toBe(at);

    await fixture.db.transaction().execute((trx) =>
      cancelRemovedMemberTasks(trx, silentLogger, clock, {
        causationId: '00000000-0000-4000-8000-0000000000aa',
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        taskIds: [removed.task.id],
      }),
    );
    expect((await storedBlocker(fixture.db, ids.remove)).resolvedAt).toBe(at);

    const review = createTaskReviewActions(fixture.db, silentLogger, clock);
    const leadPlace = { ...place, telegramUserId: String(veraAccount.id) };
    await expect(
      review.press({
        ...leadPlace,
        taskNumber: held.task.number,
        act: TASK_TRANSITION_CONFIRM,
        idempotencyKey: 'cb-held',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_OPEN_BLOCKER });
    expect((await storedBlocker(fixture.db, ids.held)).resolvedAt).toBeNull();

    const quietMark = await createTaskMarkActions(fixture.db, silentLogger, clock).press({
      ...place,
      taskNumber: quiet.task.number,
      idempotencyKey: 'cb-quiet',
    });
    expect(quietMark.closesBlocker).toBe(false);
    expect(quietMark.task.status).toBe(TASK_STATUS_REVIEW);
    expect((await storedBlocker(fixture.db, ids.quiet)).resolvedAt).toBeNull();
    await expect(
      review.press({
        ...leadPlace,
        taskNumber: quiet.task.number,
        act: TASK_TRANSITION_CONFIRM,
        idempotencyKey: 'cb-quiet-done',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_OPEN_BLOCKER });

    const done = await review.press({
      ...leadPlace,
      taskNumber: checked.task.number,
      act: TASK_TRANSITION_CONFIRM,
      idempotencyKey: 'cb-done',
    });
    expect(done.task.status).toBe(TASK_STATUS_DONE);
    expect(done.closesBlocker).toBe(false);
    expect((await storedBlocker(fixture.db, ids.check)).resolvedAt).toBe(at);

    await setStatus(fixture.db, past.task.id, TASK_STATUS_REVIEW);
    const again = await review.press({
      ...leadPlace,
      taskNumber: past.task.number,
      act: TASK_TRANSITION_CONFIRM,
      idempotencyKey: 'cb-past',
    });
    expect(again.task.status).toBe(TASK_STATUS_DONE);
    expect((await storedBlocker(fixture.db, ids.past)).resolvedAt).toBe(ids.earlier);
  });
});
