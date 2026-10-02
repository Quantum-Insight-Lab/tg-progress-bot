import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import {
  memberRemovedCancelKey,
  TASK_CANCEL_REASON_BUTTON,
  TASK_CANCEL_REASON_MEMBER,
  TASK_CANCEL_SYSTEM_ACTOR,
  TASK_CANCEL_SYSTEM_ROLE,
} from '../src/domain/tasks/cancel-task.ts';
import { TASK_ACTOR_ROLE, TASK_ASSIGNEE_LEAD, TASK_SUBJECT, TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { ABSENT_TASK_MEASURES } from '../src/domain/tasks/github-link.ts';
import { GITHUB_FACT_TYPES } from '../src/domain/tasks/github-origin.ts';
import {
  carriedToNextCanvas,
  orderPlan,
  standsInTasksBlock,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
  tasksCarriedToNextCanvas,
  tasksStandingInBlock,
  type TaskStatus,
} from '../src/domain/tasks/status.ts';
import { TASK_TRANSITION_CANCEL, transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
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
import { cancelRemovedMemberTasks, createTaskActions, createTaskCancelActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { replyToTaskCancel, parseTaskCancelData } from '../src/telegram/task-cancel.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const at = '2026-09-28T07:33:00.000Z';

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

const NEUTRAL_ACTS = [...GITHUB_FACT_TYPES, EVENT_TYPES.DIVERGENCE_DETECTED] as const;

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  alphaId: string;
  borisId: string;
  veraId: string;
  rootId: string;
}

interface StoredTask {
  id: string;
  status: string;
  assigneeId: string;
  projectId: string;
  completedAt: string | null;
  title: string;
}

function place(topicId: number | undefined, type = TASK_TOPIC_CHAT, id = telegramChatId) {
  return { type, id, topicId };
}

describe('снятие задачи', () => {
  it('INV-05 снять можно, пока задача не DONE: «Отменить» ведёт в CANCELLED, GitHub и расхождение статус не меняют', () => {
    const allowed = new Map<TaskStatus, TaskStatus>([
      [TASK_STATUS_PLANNED, TASK_STATUS_CANCELLED],
      [TASK_STATUS_IN_PROGRESS, TASK_STATUS_CANCELLED],
      [TASK_STATUS_BLOCKED, TASK_STATUS_CANCELLED],
      [TASK_STATUS_REVIEW, TASK_STATUS_CANCELLED],
    ]);
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES.filter((item) => item === status)).toHaveLength(1);
      const next = allowed.get(status);
      if (next === undefined) {
        expect(() => transitionTask(status, TASK_TRANSITION_CANCEL)).toThrowError(
          expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
        );
      } else {
        const move = transitionTask(status, TASK_TRANSITION_CANCEL);
        expect(move.from).toBe(status);
        expect(move.to).toBe(TASK_STATUS_CANCELLED);
        expect(move.to).not.toBe(status);
        expect([move.to]).toHaveLength(1);
        expect(move.closesBlocker).toBe(status === TASK_STATUS_BLOCKED);
        expect(standsInTasksBlock(move.to)).toBe(false);
        expect(orderPlan([sample(move.to)])).toEqual([]);
      }
      for (const act of NEUTRAL_ACTS) {
        expect(() => transitionTask(status, act)).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }));
      }
    }
    expect(parseTaskCancelData(`task:${TASK_TRANSITION_CANCEL}:7`)).toBe(7);
    expect(parseTaskCancelData('task:plan:7')).toBeNull();
    expect(parseTaskCancelData('task:cancel:0')).toBeNull();
  });

  it('INV-09 снятая задача на следующий день не переносится', () => {
    const carried = [TASK_STATUS_PLANNED, TASK_STATUS_IN_PROGRESS, TASK_STATUS_BLOCKED, TASK_STATUS_REVIEW];
    for (const status of TASK_STATUSES) {
      expect(carriedToNextCanvas(status)).toBe(carried.includes(status));
    }
    const rows = TASK_STATUSES.map((status) => sample(status));
    expect(tasksCarriedToNextCanvas(rows).map((task) => task.status)).toEqual(carried);
    expect(tasksCarriedToNextCanvas(rows).map((task) => task.status)).not.toContain(TASK_STATUS_CANCELLED);
    expect(tasksCarriedToNextCanvas(rows).map((task) => task.status)).not.toContain(TASK_STATUS_DONE);
    expect(tasksStandingInBlock([sample(TASK_STATUS_CANCELLED)])).toEqual([]);
  });

  it('INV-01 отмена задачи процент проекта не меняет', () => {
    const share = { completed: 2, open: 5 };
    const task = sample(TASK_STATUS_CANCELLED);
    const payload = {
      task_id: task.id,
      cancelled_by: task.assigneeId,
      reason: TASK_CANCEL_REASON_BUTTON,
    };
    expect(Object.keys(task)).not.toContain('percent');
    expect(Object.keys(payload).sort()).toEqual(['cancelled_by', 'reason', 'task_id']);
    expect(ABSENT_TASK_MEASURES).toContain('percent');
    expect(share).toEqual({ completed: 2, open: 5 });
    const move = transitionTask(TASK_STATUS_IN_PROGRESS, TASK_TRANSITION_CANCEL);
    expect(move.to).toBe(TASK_STATUS_CANCELLED);
    expect(share).toEqual({ completed: 2, open: 5 });
  });
});

function sample(status: TaskStatus): { id: string; status: TaskStatus; assigneeId: string; priority: 'normal'; createdAt: string } {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    status,
    assigneeId: '00000000-0000-4000-8000-0000000000b1',
    priority: 'normal',
    createdAt: at,
  };
}

describe('кнопка «отменить» и задачи удалённого участника', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-247 R-248 R-644 руководитель или исполнитель переводят задачу в CANCELLED, чужой — нет', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskCancelActions(fixture.db, silentLogger, clock);
    const tasks = createTaskActions(fixture.db, silentLogger, clock);
    const own = await tasks.create(draft(borisTopic, 'Своя', 'task-own'));
    const foreign = await tasks.create(draft(veraTopic, 'Чужая', 'task-foreign', veraAccount));
    const planned = await tasks.create(draft(borisTopic, 'В плане', 'task-plan'));
    await setStatus(fixture.db, planned.task.id, TASK_STATUS_PLANNED);
    const done = await tasks.create(draft(borisTopic, 'Готово', 'task-done'));
    await setStatus(fixture.db, done.task.id, TASK_STATUS_DONE);

    expect(await replyToTaskCancel(place(veraTopic), borisAccount, 'cb-member', foreign.task.number, actions)).toBeNull();
    const byRoot = await replyToTaskCancel(place(veraTopic), rootAccount, 'cb-root', foreign.task.number, actions);
    expect(byRoot?.applied).toBe(true);
    expect(byRoot?.task.status).toBe(TASK_STATUS_CANCELLED);
    expect(await replyToTaskCancel(place(undefined), borisAccount, 'cb-general', own.task.number, actions)).toBeNull();
    expect(await replyToTaskCancel(place(borisTopic), { ...borisAccount, is_bot: true }, 'cb-bot', own.task.number, actions)).toBeNull();
    expect(await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-done', done.task.number, actions)).toBeNull();

    const byAssignee = await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-own', own.task.number, actions);
    expect(byAssignee?.applied).toBe(true);
    expect(byAssignee?.task.status).toBe(TASK_STATUS_CANCELLED);
    expect(byAssignee?.task.completedAt).toBeNull();
    expect(standsInTasksBlock(byAssignee?.task.status ?? TASK_STATUS_IN_PROGRESS)).toBe(false);
    expect(carriedToNextCanvas(TASK_STATUS_CANCELLED)).toBe(false);

    const byLead = await replyToTaskCancel(place(borisTopic), veraAccount, 'cb-lead', planned.task.number, actions);
    expect(byLead?.applied).toBe(true);
    expect(byLead?.task.status).toBe(TASK_STATUS_CANCELLED);

    const blocked = await tasks.create(draft(borisTopic, 'Стоит', 'task-blocked'));
    await setStatus(fixture.db, blocked.task.id, TASK_STATUS_BLOCKED);
    const fromBlocked = await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-blocked', blocked.task.number, actions);
    expect(fromBlocked?.closesBlocker).toBe(true);
    expect(fromBlocked?.task.status).toBe(TASK_STATUS_CANCELLED);

    const stored = await tasksOf(fixture.db);
    expect(stored.find((task) => task.id === own.task.id)?.status).toBe(TASK_STATUS_CANCELLED);
    expect(stored.find((task) => task.id === foreign.task.id)?.status).toBe(TASK_STATUS_CANCELLED);
    expect(stored.find((task) => task.id === done.task.id)?.status).toBe(TASK_STATUS_DONE);
    expect(carriedToNextCanvas(TASK_STATUS_CANCELLED)).toBe(false);

    const events = await cancelEvents(fixture.db);
    expect(events.map((event) => event.key).sort()).toEqual(['cb-blocked', 'cb-lead', 'cb-own', 'cb-root']);
    expect(events.find((event) => event.key === 'cb-own')).toMatchObject({
      payload: { task_id: own.task.id, cancelled_by: fixture.borisId, reason: TASK_CANCEL_REASON_BUTTON },
      actorId: fixture.borisId,
      actorRole: TASK_ACTOR_ROLE,
      subject: TASK_SUBJECT,
    });
    expect(events.find((event) => event.key === 'cb-lead')).toMatchObject({
      payload: { task_id: planned.task.id, cancelled_by: fixture.veraId, reason: TASK_CANCEL_REASON_BUTTON },
      actorId: fixture.veraId,
      actorRole: TASK_ASSIGNEE_LEAD,
    });
    expect(events.find((event) => event.key === 'cb-root')).toMatchObject({
      payload: { task_id: foreign.task.id, cancelled_by: fixture.rootId, reason: TASK_CANCEL_REASON_BUTTON },
      actorId: fixture.rootId,
      actorRole: TASK_ASSIGNEE_LEAD,
    });
    for (const event of events) {
      expect(Object.keys(event.payload)).not.toContain('percent');
    }
  });

  it('INV-22 повтор «Отменить» не пишет второе событие и не меняет статус', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskCancelActions(fixture.db, silentLogger, clock);
    const created = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Повтор', 'task-repeat'));
    const first = await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-repeat', created.task.number, actions);
    const second = await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-repeat', created.task.number, actions);
    expect(first?.applied).toBe(true);
    expect(second?.applied).toBe(false);
    expect(second?.task.status).toBe(TASK_STATUS_CANCELLED);
    expect(second?.eventId).toBe(first?.eventId);
    expect(await replyToTaskCancel(place(borisTopic), borisAccount, 'cb-again', created.task.number, actions)).toBeNull();
    const events = await cancelEvents(fixture.db);
    expect(events).toHaveLength(1);
    expect((await tasksOf(fixture.db)).find((task) => task.id === created.task.id)?.status).toBe(TASK_STATUS_CANCELLED);
  });

  it('INV-18 INV-22 удаление участника снимает незакрытые задачи в той же транзакции, повтор ключа откатывает снятие', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const tasks = createTaskActions(fixture.db, silentLogger, clock);
    const open = await tasks.create(draft(borisTopic, 'Открытая', 'task-open'));
    const planned = await tasks.create(draft(borisTopic, 'План', 'task-planned'));
    const blocked = await tasks.create(draft(borisTopic, 'Блок', 'task-block'));
    const review = await tasks.create(draft(borisTopic, 'Ждёт', 'task-review'));
    const done = await tasks.create(draft(borisTopic, 'Сделано', 'task-finished'));
    const already = await tasks.create(draft(borisTopic, 'Снята', 'task-already'));
    const veraTask = await tasks.create(draft(veraTopic, 'Вера', 'task-vera', veraAccount));
    await setStatus(fixture.db, planned.task.id, TASK_STATUS_PLANNED);
    await setStatus(fixture.db, blocked.task.id, TASK_STATUS_BLOCKED);
    await setStatus(fixture.db, review.task.id, TASK_STATUS_REVIEW);
    await setStatus(fixture.db, done.task.id, TASK_STATUS_DONE);
    await setStatus(fixture.db, already.task.id, TASK_STATUS_CANCELLED);

    const beta = await createProjectCreation(fixture.db, silentLogger, clock).create({
      telegramUserId: String(rootAccount.id),
      name: 'Бета',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-beta',
    });
    await createMembership(fixture.db, silentLogger, clock).add({
      telegramUserId: String(rootAccount.id),
      projectId: beta.project.id,
      targetTelegramUserId: String(borisAccount.id),
      chat: 'private',
      idempotencyKey: 'add-boris-beta',
    });
    const betaTaskId = '00000000-0000-4000-8000-0000000000d1';
    await sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
      VALUES (
        ${betaTaskId}::uuid,
        ${beta.project.id}::uuid,
        1,
        'В бете',
        ${TASK_STATUS_IN_PROGRESS},
        'normal',
        ${fixture.borisId}::uuid,
        ${at}::timestamptz,
        ${at}::timestamptz,
        NULL
      )
    `.execute(fixture.db);

    await sql`
      INSERT INTO events (
        id, source, event_type, payload, created_at, idempotency_key,
        causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id
      ) VALUES (
        '00000000-0000-4000-8000-00000000e002'::uuid,
        'telegram',
        ${EVENT_TYPES.PROJECT_MEMBER_REMOVED},
        ${JSON.stringify({ project_id: fixture.alphaId, user_id: fixture.borisId, cancelled_task_ids: [] })}::jsonb,
        ${at}::timestamptz,
        'rm-rollback',
        NULL,
        NULL,
        1,
        'seed',
        'root',
        'ProjectMember',
        'seed-member'
      )
    `.execute(fixture.db);
    await expect(
      createMembership(fixture.db, silentLogger, clock).remove({
        telegramUserId: String(rootAccount.id),
        projectId: fixture.alphaId,
        targetTelegramUserId: String(borisAccount.id),
        chat: 'private',
        idempotencyKey: 'rm-rollback',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.MEMBER_DUPLICATE });
    expect((await tasksOf(fixture.db)).find((task) => task.id === open.task.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
    const stillMember = await sql<{ n: number | string }>`
      SELECT CAST(count(*) AS int) AS n FROM project_members
      WHERE project_id = ${fixture.alphaId}::uuid AND user_id = ${fixture.borisId}::uuid
    `.execute(fixture.db);
    expect(Number(stillMember.rows[0]?.n)).toBe(1);
    expect(await cancelEvents(fixture.db)).toEqual([]);

    const removed = await createMembership(fixture.db, silentLogger, clock).remove({
      telegramUserId: String(rootAccount.id),
      projectId: fixture.alphaId,
      targetTelegramUserId: String(borisAccount.id),
      chat: 'private',
      idempotencyKey: 'rm-boris',
    });
    const unclosed = [open.task.id, planned.task.id, blocked.task.id, review.task.id].sort();
    expect([...removed.cancelledTaskIds].sort()).toEqual(unclosed);

    const stored = await tasksOf(fixture.db);
    for (const id of unclosed) {
      expect(stored.find((task) => task.id === id)?.status).toBe(TASK_STATUS_CANCELLED);
    }
    expect(stored.find((task) => task.id === done.task.id)?.status).toBe(TASK_STATUS_DONE);
    expect(stored.find((task) => task.id === already.task.id)?.status).toBe(TASK_STATUS_CANCELLED);
    expect(stored.find((task) => task.id === veraTask.task.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(stored.find((task) => task.id === betaTaskId)?.status).toBe(TASK_STATUS_IN_PROGRESS);

    const gone = await sql<{ n: number | string }>`
      SELECT CAST(count(*) AS int) AS n FROM project_members
      WHERE project_id = ${fixture.alphaId}::uuid AND user_id = ${fixture.borisId}::uuid
    `.execute(fixture.db);
    expect(Number(gone.rows[0]?.n)).toBe(0);
    const betaMember = await sql<{ n: number | string }>`
      SELECT CAST(count(*) AS int) AS n FROM project_members
      WHERE project_id = ${beta.project.id}::uuid AND user_id = ${fixture.borisId}::uuid
    `.execute(fixture.db);
    expect(Number(betaMember.rows[0]?.n)).toBe(1);

    const orphans = await sql<{ id: string }>`
      SELECT tasks.id::text AS id
      FROM tasks
      LEFT JOIN project_members
        ON project_members.project_id = tasks.project_id
       AND project_members.user_id = tasks.assignee_id
      WHERE tasks.status NOT IN (${TASK_STATUS_DONE}, ${TASK_STATUS_CANCELLED})
        AND project_members.id IS NULL
    `.execute(fixture.db);
    expect(orphans.rows).toEqual([]);

    const memberEvents = await sql<{ id: string; payload: unknown }>`
      SELECT id::text AS id, payload FROM events WHERE event_type = ${EVENT_TYPES.PROJECT_MEMBER_REMOVED} AND idempotency_key = 'rm-boris'
    `.execute(fixture.db);
    expect(memberEvents.rows).toHaveLength(1);
    const memberEvent = memberEvents.rows[0];
    if (memberEvent === undefined) throw new Error('project.member_removed не найден');
    const memberPayload = payloadOf(memberEvent.payload);
    expect([...(memberPayload.cancelled_task_ids as string[])].sort()).toEqual(unclosed);

    const events = await cancelEvents(fixture.db);
    expect(events).toHaveLength(unclosed.length);
    for (const taskId of unclosed) {
      expect(events.find((event) => event.key === memberRemovedCancelKey(memberEvent.id, taskId))).toMatchObject({
        payload: { task_id: taskId, cancelled_by: TASK_CANCEL_SYSTEM_ACTOR, reason: TASK_CANCEL_REASON_MEMBER },
        actorId: TASK_CANCEL_SYSTEM_ACTOR,
        actorRole: TASK_CANCEL_SYSTEM_ROLE,
        causationId: memberEvent.id,
      });
    }
    await fixture.db.transaction().execute((trx) =>
      cancelRemovedMemberTasks(trx, silentLogger, clock, {
        causationId: memberEvent.id,
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        taskIds: unclosed,
      }),
    );
    expect(await cancelEvents(fixture.db)).toHaveLength(unclosed.length);
    const afterRepeat = await tasksOf(fixture.db);
    for (const id of unclosed) {
      expect(afterRepeat.find((task) => task.id === id)?.status).toBe(TASK_STATUS_CANCELLED);
    }
  });
});

function payloadOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  throw new Error('payload повреждён');
}

function draft(topicId: number, title: string, key: string, account = borisAccount) {
  return {
    telegramUserId: String(account.id),
    chat: TASK_TOPIC_CHAT,
    telegramChatId,
    topicId,
    title,
    idempotencyKey: key,
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
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
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
  const membership = createMembership(handle.db, silentLogger, clock);
  await membership.add({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES (${'00000000-0000-4000-8000-0000000000c1'}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE}, ${veraTopic})
  `.execute(handle.db);
  await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid AND project_id = ${alpha.project.id}::uuid`.execute(
    handle.db,
  );
  await createChatBinding(handle.db, silentLogger, clock).confirm({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    offer: forumAdmin,
    idempotencyKey: 'bind-alpha',
  });
  return {
    db: handle.db,
    close: handle.close,
    alphaId: alpha.project.id,
    borisId: boris.user.id,
    veraId: vera.user.id,
    rootId: root.user.id,
  };
}

async function setStatus(db: Kysely<Database>, id: string, status: TaskStatus): Promise<void> {
  await sql`UPDATE tasks SET status = ${status} WHERE id = ${id}::uuid`.execute(db);
}

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const result = await sql<{
    id: string;
    status: string;
    assignee_id: string;
    project_id: string;
    completed_at: Date | string | null;
    title: string;
  }>`
    SELECT id::text AS id, status, assignee_id::text AS assignee_id, project_id::text AS project_id, completed_at, title
    FROM tasks
    ORDER BY number
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    assigneeId: row.assignee_id,
    projectId: row.project_id,
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    title: row.title,
  }));
}

async function cancelEvents(db: Kysely<Database>): Promise<
  {
    key: string;
    payload: Record<string, unknown>;
    actorId: string;
    actorRole: string;
    subject: string;
    causationId: string | null;
  }[]
> {
  const result = await sql<{
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
    causation_id: string | null;
  }>`
    SELECT idempotency_key, payload, actor_id, actor_role, subject_entity, causation_id::text AS causation_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.TASK_CANCELLED}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    key: row.idempotency_key,
    payload: payloadOf(row.payload),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subject: row.subject_entity,
    causationId: row.causation_id,
  }));
}
