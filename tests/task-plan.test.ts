import type { Transformer } from 'grammy';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_ACTOR_ROLE, TASK_SUBJECT, TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { GITHUB_FACT_TYPES } from '../src/domain/tasks/github-origin.ts';
import { TASK_PRIORITY_ACT } from '../src/domain/tasks/plan-task.ts';
import { CANVAS_DESTINATION_TOPIC } from '../src/domain/tasks/place-canvas.ts';
import {
  nextPriority,
  orderPlan,
  prioritySetOnCanvas,
  standsInTasksBlock,
  TASK_PRIORITIES,
  TASK_PRIORITY_HIGH,
  TASK_PRIORITY_LOW,
  TASK_PRIORITY_NORMAL,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from '../src/domain/tasks/status.ts';
import {
  TASK_TRANSITION_PLAN,
  TASK_TRANSITION_RESUME,
  transitionTask,
} from '../src/domain/tasks/transition.ts';
import { emit, EVENT_TYPES } from '../src/events/index.ts';
import { createCanvasPlacement, type CanvasHome } from '../src/infrastructure/canvas.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import {
  readBlockersMigration,
  readCanvasesMigration,
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createTaskActions, createTaskPlanActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { TASK_PRIORITY_ACTION, TASK_RESUME_ACTION, taskCanvasActionData } from '../src/projections/tasks-block.ts';
import { parseTaskPlanData, replyToTaskPlan } from '../src/telegram/task-plan.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
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
  priority: string;
  assigneeId: string;
  createdAt: Date;
  number: number;
}

interface PlanEvent {
  type: string;
  key: string;
  payload: unknown;
  actorId: string;
  actorRole: string;
  subject: string;
}

function place(topicId: number | undefined, type = TASK_TOPIC_CHAT, id = telegramChatId) {
  return { type, id, topicId };
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
  await pglite.exec(readCanvasesMigration());
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
  await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid`.execute(handle.db);
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

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const result = await sql<{
    id: string;
    status: string;
    priority: string;
    assignee_id: string;
    created_at: Date;
    number: number | string;
  }>`
    SELECT id::text AS id, status, priority, assignee_id::text AS assignee_id, created_at, number
    FROM tasks
    ORDER BY number
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    createdAt: row.created_at,
    number: Number(row.number),
  }));
}

async function planEvents(db: Kysely<Database>): Promise<PlanEvent[]> {
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
    WHERE event_type IN (${EVENT_TYPES.TASK_PLANNED}, ${EVENT_TYPES.TASK_RESUMED}, ${EVENT_TYPES.TASK_PRIORITIZED})
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    type: row.event_type,
    key: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subject: row.subject_entity,
  }));
}

async function setStatus(db: Kysely<Database>, id: string, status: TaskStatus): Promise<void> {
  await sql`UPDATE tasks SET status = ${status} WHERE id = ${id}::uuid`.execute(db);
}

async function setPriority(db: Kysely<Database>, id: string, priority: TaskPriority): Promise<void> {
  await sql`UPDATE tasks SET priority = ${priority} WHERE id = ${id}::uuid`.execute(db);
}

async function setCreatedAt(db: Kysely<Database>, id: string, createdAt: string): Promise<void> {
  await sql`UPDATE tasks SET created_at = ${createdAt}::timestamptz WHERE id = ${id}::uuid`.execute(db);
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

describe('план и приоритет', () => {
  it('INV-05 у задачи один статус, в план и в работу только по таблице; GitHub и расхождение статус не меняют', () => {
    const allowed = new Map<string, TaskStatus>([
      [`${TASK_TRANSITION_PLAN}:${TASK_STATUS_IN_PROGRESS}`, TASK_STATUS_PLANNED],
      [`${TASK_TRANSITION_PLAN}:${TASK_STATUS_BLOCKED}`, TASK_STATUS_PLANNED],
      [`${TASK_TRANSITION_RESUME}:${TASK_STATUS_PLANNED}`, TASK_STATUS_IN_PROGRESS],
    ]);
    const acts = [TASK_TRANSITION_PLAN, TASK_TRANSITION_RESUME, ...NEUTRAL_ACTS];
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES.filter((item) => item === status)).toHaveLength(1);
      for (const act of acts) {
        const next = allowed.get(`${act}:${status}`);
        if (next === undefined) {
          expect(() => transitionTask(status, act)).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }));
          continue;
        }
        const move = transitionTask(status, act);
        expect(move.from).toBe(status);
        expect(move.to).toBe(next);
        expect([move.to]).toHaveLength(1);
        expect(move.to).not.toBe(status);
        expect(move.closesBlocker).toBe(status === TASK_STATUS_BLOCKED);
        if (next === TASK_STATUS_PLANNED) expect(standsInTasksBlock(next)).toBe(false);
        if (next === TASK_STATUS_IN_PROGRESS) expect(standsInTasksBlock(next)).toBe(true);
      }
    }
    expect(taskCanvasActionData('plan', 3)).toBe(`task:${TASK_TRANSITION_PLAN}:3`);
    expect(taskCanvasActionData(TASK_RESUME_ACTION, 3)).toBe(`task:${TASK_TRANSITION_RESUME}:3`);
    expect(taskCanvasActionData(TASK_PRIORITY_ACTION, 3)).toBe(`task:${TASK_PRIORITY_ACT}:3`);
    expect(TASK_RESUME_ACTION).toBe(TASK_TRANSITION_RESUME);
    expect(TASK_PRIORITY_ACTION).toBe(TASK_PRIORITY_ACT);
  });

  it('INV-08 приоритет по умолчанию крутится normal → high → low → normal; план сначала больший, затем раньше созданный', () => {
    expect(TASK_PRIORITY_NORMAL).toBe('normal');
    let priority: TaskPriority = TASK_PRIORITY_NORMAL;
    const turned: TaskPriority[] = [];
    for (const step of TASK_PRIORITIES) {
      void step;
      priority = nextPriority(priority);
      turned.push(priority);
    }
    expect(turned).toEqual([TASK_PRIORITY_HIGH, TASK_PRIORITY_LOW, TASK_PRIORITY_NORMAL]);
    expect(nextPriority(TASK_PRIORITY_NORMAL)).toBe(TASK_PRIORITY_HIGH);
    const early = '2026-09-27T06:00:00.000Z';
    const mid = '2026-09-27T12:00:00.000Z';
    const late = '2026-09-28T06:00:00.000Z';
    const rows: { title: string; status: TaskStatus; priority: TaskPriority; createdAt: string }[] = [
      { title: 'работа', status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_HIGH, createdAt: early },
      { title: 'низкий поздний', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_LOW, createdAt: late },
      { title: 'обычный', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_NORMAL, createdAt: mid },
      { title: 'высокий поздний', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, createdAt: late },
      { title: 'высокий ранний', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, createdAt: early },
      { title: 'снята', status: TASK_STATUS_DONE, priority: TASK_PRIORITY_HIGH, createdAt: early },
    ];
    const titles = rows.map((row) => row.title);
    expect(orderPlan(rows).map((row) => row.title)).toEqual(['высокий ранний', 'высокий поздний', 'обычный', 'низкий поздний']);
    expect(rows.map((row) => row.title)).toEqual(titles);
    expect(prioritySetOnCanvas(TASK_STATUS_PLANNED)).toBe(true);
    expect(prioritySetOnCanvas(TASK_STATUS_DONE)).toBe(false);
    expect(prioritySetOnCanvas(TASK_STATUS_CANCELLED)).toBe(false);
  });
});

describe('кнопки плана', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-05 «в план» ставит PLANNED на том же канвасе, «в работу» возвращает в Задачи; GitHub статус не меняет', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Классификация сигнала', 'task-1'));
    expect(created.task.priority).toBe(TASK_PRIORITY_NORMAL);
    expect(created.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    const actions = createTaskPlanActions(fixture.db, silentLogger, clock);
    const homes: CanvasHome[] = [];
    const edited: number[] = [];
    const canvas = createCanvasPlacement(fixture.db, silentLogger, clock);
    const deliver = {
      async send(home: CanvasHome): Promise<number> {
        homes.push(home);
        return 41;
      },
      async edit(home: CanvasHome, messageId: number): Promise<void> {
        homes.push(home);
        edited.push(messageId);
      },
    };
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: created.eventId,
      send: deliver.send,
      edit: deliver.edit,
    });
    const canvasBefore = await sql<{ id: string; message_id: string }>`
      SELECT id::text AS id, message_id::text AS message_id FROM canvases
    `.execute(fixture.db);
    expect(canvasBefore.rows).toHaveLength(1);
    expect(homes[0]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);

    const planned = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-plan', 1, TASK_TRANSITION_PLAN, actions);
    expect(planned?.applied).toBe(true);
    expect(planned?.closesBlocker).toBe(false);
    expect(planned?.task.status).toBe(TASK_STATUS_PLANNED);
    expect(planned?.task.priority).toBe(TASK_PRIORITY_NORMAL);
    expect(standsInTasksBlock(planned?.task.status ?? TASK_STATUS_IN_PROGRESS)).toBe(false);
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: planned?.eventId ?? '',
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(homes).toHaveLength(2);
    expect(homes[1]?.tasks).toEqual([]);
    expect(edited).toEqual([41]);
    const canvasAfter = await sql<{ id: string; message_id: string }>`
      SELECT id::text AS id, message_id::text AS message_id FROM canvases
    `.execute(fixture.db);
    expect(canvasAfter.rows).toEqual(canvasBefore.rows);

    await setStatus(fixture.db, created.task.id, TASK_STATUS_BLOCKED);
    const fromBlocked = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-blocked', 1, TASK_TRANSITION_PLAN, actions);
    expect(fromBlocked?.closesBlocker).toBe(true);
    expect(fromBlocked?.task.status).toBe(TASK_STATUS_PLANNED);

    const resumed = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-resume', 1, TASK_TRANSITION_RESUME, actions);
    expect(resumed?.applied).toBe(true);
    expect(resumed?.closesBlocker).toBe(false);
    expect(resumed?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(standsInTasksBlock(resumed?.task.status ?? TASK_STATUS_PLANNED)).toBe(true);
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: resumed?.eventId ?? '',
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(edited).toEqual([41, 41]);
    expect(homes[2]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    expect(homes).toHaveLength(3);

    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      source: 'github',
      idempotencyKey: 'gh-status',
      payload: {
        repository_id: 'repo-1',
        issue_number: 1,
        title: 'закрыли',
        state: 'closed',
        state_reason: 'completed',
        assignees: ['boris'],
        closed_by_login: 'boris',
        updated_at: at,
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Issue', id: '1' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.DIVERGENCE_DETECTED,
      source: 'system',
      idempotencyKey: 'div-status',
      payload: { project_id: fixture.alphaId, date: '2026-09-28' },
      actor: { id: 'system', role: 'system' },
      subject: { entity: 'Project', id: fixture.alphaId },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    const stored = await tasksOf(fixture.db);
    expect(stored.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    expect(stored[0]?.priority).toBe(TASK_PRIORITY_NORMAL);
    const events = await planEvents(fixture.db);
    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.TASK_PLANNED,
      EVENT_TYPES.TASK_PLANNED,
      EVENT_TYPES.TASK_RESUMED,
    ]);
    expect(events[0]).toMatchObject({
      key: 'cb-blocked',
      payload: { task_id: created.task.id },
      actorId: fixture.borisId,
      actorRole: TASK_ACTOR_ROLE,
      subject: TASK_SUBJECT,
    });
    expect(Object.keys(events[2]?.payload as object).sort()).toEqual(['task_id']);
  });

  it('INV-07 «в план», «в работу» и слово приоритета нажимает только исполнитель', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const own = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Своя', 'task-boris'));
    const leadTask = await createTaskActions(fixture.db, silentLogger, clock).create(draft(veraTopic, 'Руководителя', 'task-vera', veraAccount));
    const actions = createTaskPlanActions(fixture.db, silentLogger, clock);
    expect(await replyToTaskPlan(place(borisTopic), veraAccount, 'cb-lead', 1, TASK_TRANSITION_PLAN, actions)).toBeNull();
    expect(await replyToTaskPlan(place(borisTopic), rootAccount, 'cb-root', 1, TASK_TRANSITION_PLAN, actions)).toBeNull();
    expect(await replyToTaskPlan(place(veraTopic), borisAccount, 'cb-foreign', leadTask.task.number, TASK_TRANSITION_PLAN, actions)).toBeNull();
    expect(await replyToTaskPlan(place(borisTopic), veraAccount, 'cb-lead-word', 1, TASK_PRIORITY_ACT, actions)).toBeNull();
    expect(await replyToTaskPlan(place(undefined), borisAccount, 'cb-general', 1, TASK_TRANSITION_PLAN, actions)).toBeNull();
    expect(await replyToTaskPlan(place(borisTopic, 'private', '1002'), borisAccount, 'cb-private', 1, TASK_TRANSITION_RESUME, actions)).toBeNull();
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS, TASK_STATUS_IN_PROGRESS]);
    expect(await planEvents(fixture.db)).toEqual([]);

    const planned = await replyToTaskPlan(place(veraTopic), veraAccount, 'cb-vera', leadTask.task.number, TASK_TRANSITION_PLAN, actions);
    expect(planned?.task.status).toBe(TASK_STATUS_PLANNED);
    expect(planned?.task.assigneeId).toBe(fixture.veraId);
    expect(await replyToTaskPlan(place(veraTopic), borisAccount, 'cb-resume-foreign', leadTask.task.number, TASK_TRANSITION_RESUME, actions)).toBeNull();
    expect((await tasksOf(fixture.db)).find((task) => task.id === leadTask.task.id)?.status).toBe(TASK_STATUS_PLANNED);
    const word = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-own-word', own.task.number, TASK_PRIORITY_ACT, actions);
    expect(word?.task.priority).toBe(TASK_PRIORITY_HIGH);
    expect(word?.task.assigneeId).toBe(fixture.borisId);
    expect((await tasksOf(fixture.db)).find((task) => task.id === own.task.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
  });

  it('INV-08 слово приоритета на канвасе крутит normal → high → low → normal и задаёт порядок плана', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskPlanActions(fixture.db, silentLogger, clock);
    const first = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Ранняя', 'task-early'));
    const second = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Поздняя', 'task-late'));
    const third = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Средняя', 'task-mid'));
    expect(first.task.priority).toBe(TASK_PRIORITY_NORMAL);
    const high = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-high', first.task.number, TASK_PRIORITY_ACT, actions);
    expect(high?.task.priority).toBe(TASK_PRIORITY_HIGH);
    expect(high?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    const low = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-low', first.task.number, TASK_PRIORITY_ACT, actions);
    expect(low?.task.priority).toBe(TASK_PRIORITY_LOW);
    const back = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-normal', first.task.number, TASK_PRIORITY_ACT, actions);
    expect(back?.task.priority).toBe(TASK_PRIORITY_NORMAL);
    const again = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-high-2', first.task.number, TASK_PRIORITY_ACT, actions);
    expect(again?.task.priority).toBe(TASK_PRIORITY_HIGH);
    const events = await planEvents(fixture.db);
    expect(events.map((event) => event.payload)).toEqual([
      { task_id: first.task.id, priority: TASK_PRIORITY_HIGH, previous_priority: TASK_PRIORITY_NORMAL },
      { task_id: first.task.id, priority: TASK_PRIORITY_HIGH, previous_priority: TASK_PRIORITY_NORMAL },
      { task_id: first.task.id, priority: TASK_PRIORITY_LOW, previous_priority: TASK_PRIORITY_HIGH },
      { task_id: first.task.id, priority: TASK_PRIORITY_NORMAL, previous_priority: TASK_PRIORITY_LOW },
    ]);
    expect(events.every((event) => event.actorRole === TASK_ACTOR_ROLE && event.subject === TASK_SUBJECT)).toBe(true);

    await setPriority(fixture.db, second.task.id, TASK_PRIORITY_LOW);
    await setPriority(fixture.db, third.task.id, TASK_PRIORITY_NORMAL);
    await setCreatedAt(fixture.db, first.task.id, '2026-09-28T08:00:00.000Z');
    await setCreatedAt(fixture.db, second.task.id, '2026-09-27T08:00:00.000Z');
    await setCreatedAt(fixture.db, third.task.id, '2026-09-27T09:00:00.000Z');
    for (const task of [first, second, third]) {
      await replyToTaskPlan(place(borisTopic), borisAccount, `cb-plan-${task.task.number}`, task.task.number, TASK_TRANSITION_PLAN, actions);
    }
    const stored = await tasksOf(fixture.db);
    const ordered = orderPlan(
      stored.map((task) => ({
        status: task.status as TaskStatus,
        priority: task.priority as TaskPriority,
        createdAt: task.createdAt.toISOString(),
        number: task.number,
      })),
    );
    expect(ordered.map((task) => task.number)).toEqual([first.task.number, third.task.number, second.task.number]);

    await setStatus(fixture.db, first.task.id, TASK_STATUS_DONE);
    expect(await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-done', first.task.number, TASK_PRIORITY_ACT, actions)).toBeNull();
    await setStatus(fixture.db, first.task.id, TASK_STATUS_REVIEW);
    const onReview = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-review', first.task.number, TASK_PRIORITY_ACT, actions);
    expect(onReview?.task.priority).toBe(TASK_PRIORITY_LOW);
    expect(onReview?.task.status).toBe(TASK_STATUS_REVIEW);
    expect(await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-review-plan', first.task.number, TASK_TRANSITION_PLAN, actions)).toBeNull();
    expect((await tasksOf(fixture.db)).find((task) => task.id === first.task.id)?.status).toBe(TASK_STATUS_REVIEW);
  });

  it('INV-22 повтор того же callback не пишет второе событие и не крутит задачу ещё раз', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, silentLogger, clock).create(draft(borisTopic, 'Повтор', 'task-2'));
    const actions = createTaskPlanActions(fixture.db, silentLogger, clock);
    const first = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-same', 1, TASK_TRANSITION_PLAN, actions);
    const second = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-same', 1, TASK_TRANSITION_PLAN, actions);
    expect(first?.applied).toBe(true);
    expect(second?.applied).toBe(false);
    expect(second?.task.status).toBe(TASK_STATUS_PLANNED);
    expect(second?.eventId).toBe(first?.eventId);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_PLANNED]);
    expect(await planEvents(fixture.db)).toHaveLength(1);

    const word = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-word', 1, TASK_PRIORITY_ACT, actions);
    const wordAgain = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-word', 1, TASK_PRIORITY_ACT, actions);
    expect(word?.applied).toBe(true);
    expect(word?.task.priority).toBe(TASK_PRIORITY_HIGH);
    expect(wordAgain?.applied).toBe(false);
    expect(wordAgain?.task.priority).toBe(TASK_PRIORITY_HIGH);
    expect(wordAgain?.eventId).toBe(word?.eventId);

    const blank = await replyToTaskPlan(place(borisTopic), borisAccount, '   ', 1, TASK_TRANSITION_RESUME, actions);
    expect(blank).toBeNull();
    const resumed = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-back', 1, TASK_TRANSITION_RESUME, actions);
    const resumedAgain = await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-back', 1, TASK_TRANSITION_RESUME, actions);
    expect(resumed?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(resumedAgain?.applied).toBe(false);
    expect(resumedAgain?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect((await tasksOf(fixture.db))[0]?.priority).toBe(TASK_PRIORITY_HIGH);
    expect((await planEvents(fixture.db)).map((event) => event.key).sort()).toEqual(['cb-back', 'cb-same', 'cb-word']);
    expect(created.task.id).toBe(first?.task.id);
    expect(await replyToTaskPlan(place(borisTopic), borisAccount, 'cb-no', 1, TASK_TRANSITION_RESUME, actions)).toBeNull();
    expect(parseTaskPlanData('task:plan:7')).toEqual({ act: TASK_TRANSITION_PLAN, taskNumber: 7 });
    expect(parseTaskPlanData('task:resume:7')).toEqual({ act: TASK_TRANSITION_RESUME, taskNumber: 7 });
    expect(parseTaskPlanData('task:priority:7')).toEqual({ act: TASK_PRIORITY_ACT, taskNumber: 7 });
    expect(parseTaskPlanData('task:mark:7')).toBeNull();
    expect(parseTaskPlanData('task:plan:0')).toBeNull();
  });
});

describe('бот принимает план и приоритет по callback', () => {
  const calls: { method: string; payload: unknown }[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  function capture(): Transformer {
    return (async (_prev, method, payload) => {
      calls.push({ method, payload });
      if (method === 'sendMessage' || method === 'sendRichMessage' || method === 'editMessageText') {
        return {
          ok: true,
          result: {
            message_id: 77,
            date: 1,
            chat: { id: Number(telegramChatId), type: 'supergroup' },
            rich_message: { blocks: [] },
          },
        };
      }
      return { ok: true, result: true };
    }) as Transformer;
  }

  function callback(updateId: number, account: { id: number; is_bot: boolean; first_name: string }, id: string, data: string, topic: number): string {
    return JSON.stringify({
      update_id: updateId,
      callback_query: {
        id,
        from: account,
        chat_instance: '1',
        data,
        message: {
          message_id: 77,
          date: 1700000000,
          message_thread_id: topic,
          chat: { id: Number(telegramChatId), type: 'supergroup', is_forum: true },
        },
      },
    });
  }

  it('R-231 «в план» уносит задачу в PLANNED, R-579 «в работу» возвращает, R-239 слово приоритета крутится', async () => {
    const fixture = await seed();
    opened.push(fixture);
    running = await startProcess({
      ...readProcessConfig(
        {
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
          PORT: '0',
          SCHEDULER_INTERVAL_MS: '60000',
        },
        clock,
      ),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: fixture.db,
    });
    running.bot.api.config.use(capture());
    const postedCode = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      JSON.stringify({
        update_id: 930,
        message: {
          message_id: 930,
          date: 1700000000,
          message_thread_id: borisTopic,
          chat: { id: Number(telegramChatId), type: 'supergroup', is_forum: true },
          from: borisAccount,
          text: '/task Классификация сигнала',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
      }),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(postedCode).toBe(200);
    const posted = calls.find((call) => call.method === 'sendRichMessage');
    expect(JSON.stringify(posted?.payload)).toContain('task:plan:1');
    expect(JSON.stringify(posted?.payload)).toContain('task:priority:1');
    expect(JSON.stringify(posted?.payload)).toContain('normal');

    const word = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(931, borisAccount, 'cb-bot-word', 'task:priority:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(word).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.priority).toBe(TASK_PRIORITY_HIGH);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_IN_PROGRESS);
    const afterWord = calls.filter((call) => call.method === 'editMessageText');
    expect(afterWord).toHaveLength(1);
    expect(JSON.stringify(afterWord[0]?.payload)).toContain('high');
    expect(JSON.stringify(afterWord[0]?.payload)).toContain('Классификация сигнала');

    const planned = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(932, borisAccount, 'cb-bot-plan', 'task:plan:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(planned).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_PLANNED);
    const afterPlan = calls.filter((call) => call.method === 'editMessageText');
    expect(afterPlan).toHaveLength(2);
    const plannedPayload = JSON.stringify(afterPlan[1]?.payload);
    expect(plannedPayload).toContain('План');
    expect(plannedPayload).toContain('Классификация сигнала');
    expect(plannedPayload).toContain('task:resume:1');
    expect(plannedPayload).toContain('в работу');
    expect(plannedPayload).toContain('task:priority:1');
    expect(plannedPayload).toContain('high');
    expect(plannedPayload).not.toContain('task:mark:1');
    expect(plannedPayload).not.toContain('task:plan:1');
    expect(plannedPayload).not.toContain('○');
    expect(calls.filter((call) => call.method === 'sendRichMessage')).toHaveLength(1);

    const foreign = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(933, veraAccount, 'cb-bot-foreign', 'task:resume:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(foreign).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_PLANNED);
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(2);

    const resumed = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(934, borisAccount, 'cb-bot-resume', 'task:resume:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(resumed).toBe(200);
    expect((await tasksOf(fixture.db)).map((task) => ({ status: task.status, priority: task.priority }))).toEqual([
      { status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_HIGH },
    ]);
    const afterResume = calls.filter((call) => call.method === 'editMessageText');
    expect(afterResume).toHaveLength(3);
    expect(JSON.stringify(afterResume[2]?.payload)).toContain('Классификация сигнала');
    expect(JSON.stringify(afterResume[2]?.payload)).toContain('task:plan:1');
    expect(JSON.stringify(afterResume[2]?.payload)).not.toContain('План');
    expect(JSON.stringify(afterResume[2]?.payload)).not.toContain('task:resume:1');
    expect(calls.filter((call) => call.method === 'sendRichMessage')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'answerCallbackQuery')).toBe(true);
    const events = await planEvents(fixture.db);
    expect(events.map((event) => event.key)).toEqual(['cb-bot-plan', 'cb-bot-resume', 'cb-bot-word']);
    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.TASK_PLANNED,
      EVENT_TYPES.TASK_RESUMED,
      EVENT_TYPES.TASK_PRIORITIZED,
    ]);
  });
});
