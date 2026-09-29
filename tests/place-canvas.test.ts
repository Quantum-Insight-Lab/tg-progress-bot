import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import { defineCanvas, type Canvas } from '../src/domain/tasks/canvas.ts';
import {
  CANVAS_ACTOR_ROLE,
  CANVAS_DESTINATION_PRIVATE,
  CANVAS_DESTINATION_TOPIC,
  CANVAS_SUBJECT,
  decideCanvasMove,
  type CanvasSlotState,
} from '../src/domain/tasks/place-canvas.ts';
import {
  TASK_PRIORITY_HIGH,
  TASK_PRIORITY_LOW,
  TASK_PRIORITY_NORMAL,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
} from '../src/domain/tasks/status.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { ensureTodayCanvases, showCanvas, showCanvasForTopic, type CanvasHome, type CanvasTaskLine } from '../src/infrastructure/canvas.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createExecutorTopics } from '../src/infrastructure/executor-topic.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import {
  readCanvasItemsMigration,
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
import { createTaskActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { renderFirstEmployeeMessage } from '../src/projections/first-employee-message.ts';
import { renderCanvas, type CanvasRichText } from '../src/projections/canvas-message.ts';
import { planBlockParagraphs } from '../src/projections/plan-block.ts';
import { tasksBlockParagraphs } from '../src/projections/tasks-block.ts';
import {
  EXECUTOR_TOPIC_CREATED,
  EXECUTOR_TOPIC_EMPTY,
  replyToCreateTopic,
  type TopicChannel,
} from '../src/telegram/executor-topic.ts';
import { replyToTaskCommand } from '../src/telegram/task-command.ts';

const noon = new Date('2026-09-28T12:00:00.000Z');
const clock: Clock = { now: () => noon };
const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const leadId = '00000000-0000-4000-8000-0000000000b3';
const causationA = '00000000-0000-4000-8000-0000000000e1';
const causationB = '00000000-0000-4000-8000-0000000000e2';

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

interface Io {
  sent: CanvasHome[];
  edited: { home: CanvasHome; messageId: number }[];
  send(home: CanvasHome): Promise<number>;
  edit(home: CanvasHome, messageId: number): Promise<void>;
}

function slot(over: Partial<CanvasSlotState> = {}): CanvasSlotState {
  return {
    timezone: 'Europe/Moscow',
    bound: true,
    telegramChatId: telegramChatId,
    topicId: 42,
    existing: null,
    ...over,
  };
}

function canvasOf(date: string, messageId: number): Canvas {
  return defineCanvas({
    id: '00000000-0000-4000-8000-0000000000c1',
    projectId: '00000000-0000-4000-8000-000000000010',
    assigneeId: '00000000-0000-4000-8000-000000000001',
    topicId: 42,
    messageId,
    canvasDate: date,
  });
}

function shown(canvasDate: string, tasks: readonly CanvasTaskLine[] = [], plan: readonly CanvasTaskLine[] = []): CanvasHome {
  return {
    telegramChatId,
    topicId: 42,
    projectName: 'Альфа',
    canvasDate,
    tasks,
    plan,
    backlogShare: null,
    person: { name: 'Борис', place: { kind: 'unmatched' } },
    issueSlice: { done: [], inProgress: [], next: [] },
    github: null,
  };
}

function openTask(title: string): CanvasTaskLine {
  return { number: 1, title, status: TASK_STATUS_IN_PROGRESS, day: 1, priority: TASK_PRIORITY_NORMAL };
}

function visibleCanvas(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visibleCanvas).join('');
  return text.button.text;
}

function io(): Io {
  const sent: CanvasHome[] = [];
  const edited: { home: CanvasHome; messageId: number }[] = [];
  let next = 10;
  return {
    sent,
    edited,
    async send(home) {
      sent.push(home);
      next += 1;
      return next;
    },
    async edit(home, messageId) {
      edited.push({ home, messageId });
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
  await pglite.exec(readTasksMigration());
  await pglite.exec(readCanvasesMigration());
  await pglite.exec(readCanvasItemsMigration());
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
  const alpha = await createProjectCreation(handle.db, clock).create({
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
  return { db: handle.db, close: handle.close, alphaId: alpha.project.id, borisId: boris.user.id };
}

async function setTopic(db: Kysely<Database>, userId: string, topicId: number): Promise<void> {
  await sql`UPDATE project_members SET topic_id = ${topicId} WHERE user_id = ${userId}::uuid`.execute(db);
}

async function setTimezone(db: Kysely<Database>, projectId: string, timezone: string): Promise<void> {
  await sql`UPDATE projects SET timezone = ${timezone} WHERE id = ${projectId}::uuid`.execute(db);
}

interface StoredCanvas {
  projectId: string;
  assigneeId: string;
  topicId: string;
  messageId: string;
  canvasDate: string;
}

async function canvasesOf(db: Kysely<Database>): Promise<StoredCanvas[]> {
  const result = await sql<StoredCanvas>`
    SELECT project_id::text AS "projectId",
           assignee_id::text AS "assigneeId",
           topic_id::text AS "topicId",
           message_id::text AS "messageId",
           canvas_date::text AS "canvasDate"
    FROM canvases
    ORDER BY canvas_date, message_id
  `.execute(db);
  return result.rows;
}

async function eventTypes(db: Kysely<Database>, type: string): Promise<{ key: string; payload: unknown; causationId: string | null }[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown; causation_id: string | null }>`
    SELECT idempotency_key, payload, causation_id::text AS causation_id
    FROM events
    WHERE event_type = ${type}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    key: row.idempotency_key,
    causationId: row.causation_id,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

async function taskStatuses(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ status: string }>`SELECT status FROM tasks ORDER BY number`.execute(db);
  return result.rows.map((row) => row.status);
}

describe('INV-23 канвас — одно сообщение в топике исполнителя', () => {
  const now = noon;
  const today = canvasOf('2026-09-28', 11);

  it('INV-23 личка канвас не дублирует и меню задач не показывает', () => {
    expect(() => decideCanvasMove(CANVAS_DESTINATION_PRIVATE, slot(), now)).toThrow(DomainError);
    try {
      decideCanvasMove(CANVAS_DESTINATION_PRIVATE, slot(), now);
    } catch (error) {
      expect(error).toMatchObject({ code: DOMAIN_ERROR.CANVAS_PRIVATE });
    }
  });

  it('INV-23 пока группа не привязана, канваса нет; без топика сообщение не создаётся', () => {
    expect(() => decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ bound: false, telegramChatId: null }), now)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_UNBOUND }),
    );
    expect(() => decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ topicId: null }), now)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_NO_TOPIC }),
    );
  });

  it('INV-23 нет канваса на сегодня — новое сообщение, уже есть — правка того же', () => {
    expect(decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot(), now)).toEqual({
      kind: 'post',
      canvasDate: '2026-09-28',
      telegramChatId,
      topicId: 42,
    });
    expect(decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ existing: today }), now)).toEqual({
      kind: 'edit',
      canvas: today,
    });
  });
});

describe('INV-24 сегодня канваса — сутки проекта', () => {
  const boundary = new Date('2026-09-28T21:00:00.000Z');

  it('INV-24 одна и та же минута в Москве уже завтра, на Гонолулу ещё сегодня; вчерашний канвас не правится', () => {
    const moscow = decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ timezone: 'Europe/Moscow' }), boundary);
    const honolulu = decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ timezone: 'Pacific/Honolulu' }), boundary);
    expect(moscow).toMatchObject({ kind: 'post', canvasDate: '2026-09-29' });
    expect(honolulu).toMatchObject({ kind: 'post', canvasDate: '2026-09-28' });
    const yesterday = canvasOf('2026-09-28', 11);
    const next = decideCanvasMove(CANVAS_DESTINATION_TOPIC, slot({ existing: yesterday }), boundary);
    expect(next).toMatchObject({ kind: 'post', canvasDate: '2026-09-29' });
    expect(yesterday.messageId).toBe(11);
    expect(yesterday.canvasDate).toBe('2026-09-28');
  });
});

describe('канвас выставляется в топик', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-23 новое сообщение в топике, повтор того же дня правит его, личка и чужие сообщения остаются', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    const told: string[] = [];
    const directed: string[] = [];
    const talking: TopicChannel = {
      async create(chat) {
        expect(chat).toBe(telegramChatId);
        return 42;
      },
      async tell(_chat, topicId, text) {
        told.push(`${topicId}:${text}`);
      },
      async direct(telegramUserId, text) {
        directed.push(`${telegramUserId}:${text}`);
      },
    };
    const gate = io();
    const created = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-boris',
      createExecutorTopics(fixture.db, clock),
      talking,
      {
        posted(input) {
          return showCanvasForTopic(fixture.db, {
            ...input,
            now: noon,
            causationId: null,
            send: gate.send,
            edit: gate.edit,
          }).then(() => undefined);
        },
      },
    );
    expect(created?.text).toBe(EXECUTOR_TOPIC_CREATED);
    const employee = renderFirstEmployeeMessage({ projectName: 'Альфа', topicId: 42, githubLogin: null });
    expect(told).toEqual([`42:${employee}`]);
    expect(directed).toEqual([`${borisAccount.id}:${employee}`]);
    expect(gate.sent).toEqual([shown('2026-09-28')]);
    expect(gate.edited).toEqual([]);
    expect(directed.join('\n')).not.toContain('меню');
    const posted = await canvasesOf(fixture.db);
    expect(posted).toEqual([
      {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        topicId: '42',
        messageId: '11',
        canvasDate: '2026-09-28',
      },
    ]);
    const postedEvents = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_POSTED);
    expect(postedEvents).toHaveLength(1);
    expect(postedEvents[0]?.payload).toMatchObject({
      project_id: fixture.alphaId,
      assignee_id: fixture.borisId,
      canvas_date: '2026-09-28',
      message_id: 11,
    });

    const taskReply = await replyToTaskCommand(
      { type: 'supergroup', id: telegramChatId, topicId: 42 },
      borisAccount,
      'task-boris',
      'Сделать',
      createTaskActions(fixture.db, clock),
      {
        redraw(input) {
          return showCanvas(fixture.db, {
            projectId: input.projectId,
            assigneeId: input.assigneeId,
            destination: CANVAS_DESTINATION_TOPIC,
            now: noon,
            causationId: input.causationId,
            send: gate.send,
            edit: gate.edit,
          }).then(() => undefined);
        },
      },
    );
    expect(taskReply).toContain('Сделать');
    expect(gate.sent).toHaveLength(1);
    expect(gate.edited).toEqual([
      {
        home: shown('2026-09-28', [openTask('Сделать')]),
        messageId: 11,
      },
    ]);
    expect(await canvasesOf(fixture.db)).toEqual(posted);
    const edited = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_EDITED);
    expect(edited).toHaveLength(1);
    expect(edited[0]?.payload).toEqual({ canvas_id: postedEvents[0] && (postedEvents[0].payload as { canvas_id: string }).canvas_id, shrunk: false });
    expect(edited[0]?.causationId).toBeTruthy();

    await expect(
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_TOPIC,
        now: noon,
        causationId: edited[0]?.causationId ?? causationA,
        send: gate.send,
        edit: gate.edit,
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_DUPLICATE });
    expect(gate.sent).toHaveLength(1);
    expect(await eventTypes(fixture.db, EVENT_TYPES.CANVAS_EDITED)).toHaveLength(1);
    expect(await eventTypes(fixture.db, EVENT_TYPES.CANVAS_POSTED)).toHaveLength(1);

    const refused = io();
    await expect(
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_PRIVATE,
        now: noon,
        causationId: null,
        send: refused.send,
        edit: refused.edit,
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_PRIVATE });
    expect(refused.sent).toEqual([]);
    expect(refused.edited).toEqual([]);
  });

  it('INV-23 пока супергруппа не привязана, канвас не ставится', async () => {
    const fixture = await seed(false);
    opened.push(fixture);
    const noticed: string[] = [];
    const created = await replyToCreateTopic(
      'private',
      rootAccount,
      fixture.alphaId,
      String(borisAccount.id),
      'create-unbound',
      createExecutorTopics(fixture.db, clock),
      {
        async create() {
          return 42;
        },
        async tell() {
          return undefined;
        },
        async direct() {
          return undefined;
        },
      },
      {
        async posted() {
          noticed.push('posted');
        },
      },
    );
    expect(created?.text).toBe(EXECUTOR_TOPIC_EMPTY);
    expect(noticed).toEqual([]);
    expect(await canvasesOf(fixture.db)).toEqual([]);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    await expect(
      showCanvasForTopic(fixture.db, {
        telegramUserId: String(borisAccount.id),
        topicId: 42,
        now: noon,
        causationId: null,
        send: gate.send,
        edit: gate.edit,
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_UNBOUND });
    expect(gate.sent).toEqual([]);
  });

  it('INV-09 правка и новый день не снимают задачи и не заводят второе сообщение на ту же дату', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const statuses = [
      TASK_STATUS_IN_PROGRESS,
      TASK_STATUS_BLOCKED,
      TASK_STATUS_REVIEW,
      TASK_STATUS_PLANNED,
      TASK_STATUS_CANCELLED,
      TASK_STATUS_DONE,
    ];
    for (const [index, status] of statuses.entries()) {
      const number = index + 1;
      await sql`
        INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
        VALUES (
          ${`00000000-0000-4000-8000-0000000000a${number}`}::uuid,
          ${fixture.alphaId}::uuid,
          ${number},
          ${status},
          ${status},
          'normal',
          ${fixture.borisId}::uuid,
          ${noon.toISOString()}::timestamptz,
          ${noon.toISOString()}::timestamptz,
          NULL
        )
      `.execute(fixture.db);
    }
    const gate = io();
    const first = await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    expect(first.action).toBe('post');
    const again = await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: causationA,
      send: gate.send,
      edit: gate.edit,
    });
    expect(again.action).toBe('edit');
    expect(again.canvas.messageId).toBe(first.canvas.messageId);
    expect(again.canvas.id).toBe(first.canvas.id);
    const nextDay = new Date('2026-09-28T21:00:00.000Z');
    const tomorrow = await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: nextDay,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    expect(tomorrow.action).toBe('post');
    expect(tomorrow.canvas.canvasDate).toBe('2026-09-29');
    expect(tomorrow.canvas.messageId).not.toBe(first.canvas.messageId);
    const rows = await canvasesOf(fixture.db);
    expect(rows.map((row) => row.canvasDate)).toEqual(['2026-09-28', '2026-09-29']);
    expect(rows[0]?.messageId).toBe(String(first.canvas.messageId));
    expect(await taskStatuses(fixture.db)).toEqual(statuses);
    expect(await eventTypes(fixture.db, EVENT_TYPES.TASK_CANCELLED)).toEqual([]);
    expect(gate.sent).toHaveLength(2);
    expect(gate.edited).toHaveLength(1);
    const edited = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_EDITED);
    expect(edited.map((row) => row.payload)).toEqual([{ canvas_id: first.canvas.id, shrunk: false }]);
    expect(edited[0]?.key.startsWith(first.canvas.id)).toBe(true);
    expect(CANVAS_ACTOR_ROLE).toBe('system');
    expect(CANVAS_SUBJECT).toBe('Canvas');
  });

  it('INV-05 канвас кладёт в «Задачи» только IN_PROGRESS, BLOCKED и REVIEW', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const rows = [
      { number: 1, status: TASK_STATUS_PLANNED, title: 'На потом' },
      { number: 2, status: TASK_STATUS_DONE, title: 'Уже подтверждена' },
      { number: 3, status: TASK_STATUS_CANCELLED, title: 'Снятая' },
      { number: 4, status: TASK_STATUS_IN_PROGRESS, title: 'Классификация сигнала' },
      { number: 5, status: TASK_STATUS_BLOCKED, title: 'Ждёт ответ' },
      { number: 6, status: TASK_STATUS_REVIEW, title: 'Черновик карточки' },
    ];
    for (const row of rows) {
      await sql`
        INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
        VALUES (
          ${`00000000-0000-4000-8000-0000000000d${String(row.number)}`}::uuid,
          ${fixture.alphaId}::uuid,
          ${row.number},
          ${row.title},
          ${row.status},
          'normal',
          ${fixture.borisId}::uuid,
          ${noon.toISOString()}::timestamptz,
          ${noon.toISOString()}::timestamptz,
          NULL
        )
      `.execute(fixture.db);
    }
    const gate = io();
    await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    expect(gate.sent[0]?.tasks.map((task) => task.status)).toEqual([
      TASK_STATUS_IN_PROGRESS,
      TASK_STATUS_BLOCKED,
      TASK_STATUS_REVIEW,
    ]);
    expect(gate.sent[0]?.tasks.map((task) => task.title)).toEqual([
      'Классификация сигнала',
      'Ждёт ответ',
      'Черновик карточки',
    ]);
    const text = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: { tasks: tasksBlockParagraphs(gate.sent[0]?.tasks ?? []) },
    }).blocks.map((block) => visibleCanvas(block.text)).join('\n');
    expect(text).toContain('○ 4 — Классификация сигнала — 1-й день');
    expect(text).toContain('○ 5 — Ждёт ответ — 1-й день');
    expect(text).toContain('✓ 6 — Черновик карточки — на подтверждении');
    expect(text).not.toContain('На потом');
    expect(text).not.toContain('Уже подтверждена');
    expect(text).not.toContain('Снятая');
    await sql`
      UPDATE tasks SET status = ${TASK_STATUS_IN_PROGRESS}
      WHERE number = 6 AND project_id = ${fixture.alphaId}::uuid
    `.execute(fixture.db);
    await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: causationA,
      send: gate.send,
      edit: gate.edit,
    });
    const returned = gate.edited[0]?.home.tasks.find((task) => task.number === 6);
    expect(returned).toMatchObject({ title: 'Черновик карточки', status: TASK_STATUS_IN_PROGRESS });
    const redrawn = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: { tasks: tasksBlockParagraphs(gate.edited[0]?.home.tasks ?? []) },
    }).blocks.map((block) => visibleCanvas(block.text)).join('\n');
    expect(redrawn).toContain('○ 6 — Черновик карточки — 1-й день');
    expect(redrawn).not.toContain('на подтверждении');
    expect(redrawn).not.toContain('✓');
  });

  it('INV-08 R-495 план канваса — PLANNED исполнителя по приоритету, затем по дате', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const vera = await sql<{ id: string }>`
      SELECT id::text AS id FROM users WHERE telegram_user_id = ${veraAccount.id}
    `.execute(fixture.db);
    const veraId = vera.rows[0]?.id;
    if (veraId === undefined) throw new Error('Веры нет');
    const rows = [
      { number: 1, title: 'высокий поздний', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, created: '2026-09-28T10:00:00.000Z', assignee: fixture.borisId },
      { number: 2, title: 'обычный', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_NORMAL, created: '2026-09-28T09:00:00.000Z', assignee: fixture.borisId },
      { number: 3, title: 'высокий ранний', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, created: '2026-09-28T08:00:00.000Z', assignee: fixture.borisId },
      { number: 4, title: 'низкий', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_LOW, created: '2026-09-28T07:00:00.000Z', assignee: fixture.borisId },
      { number: 5, title: 'Классификация сигнала', status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_NORMAL, created: '2026-09-28T06:00:00.000Z', assignee: fixture.borisId },
      { number: 6, title: 'Уже подтверждена', status: TASK_STATUS_DONE, priority: TASK_PRIORITY_HIGH, created: '2026-09-28T05:00:00.000Z', assignee: fixture.borisId },
      { number: 7, title: 'Чужой план', status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, created: '2026-09-28T04:00:00.000Z', assignee: veraId },
    ];
    for (const row of rows) {
      await sql`
        INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
        VALUES (
          ${`00000000-0000-4000-8000-0000000000f${String(row.number)}`}::uuid,
          ${fixture.alphaId}::uuid,
          ${row.number},
          ${row.title},
          ${row.status},
          ${row.priority},
          ${row.assignee}::uuid,
          ${row.created}::timestamptz,
          ${row.created}::timestamptz,
          NULL
        )
      `.execute(fixture.db);
    }
    const gate = io();
    await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    expect(gate.sent[0]?.tasks.map((task) => task.title)).toEqual(['Классификация сигнала']);
    expect(gate.sent[0]?.plan.map((task) => task.title)).toEqual([
      'высокий ранний',
      'высокий поздний',
      'обычный',
      'низкий',
    ]);
    expect(gate.sent[0]?.plan.map((task) => task.status)).toEqual([
      TASK_STATUS_PLANNED,
      TASK_STATUS_PLANNED,
      TASK_STATUS_PLANNED,
      TASK_STATUS_PLANNED,
    ]);
    const text = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: {
        tasks: tasksBlockParagraphs(gate.sent[0]?.tasks ?? []),
        plan: planBlockParagraphs(gate.sent[0]?.plan ?? []),
      },
    }).blocks.map((block) => visibleCanvas(block.text)).join('\n');
    expect(text).toContain('План');
    expect(text).toContain('3 — высокий ранний — 1-й день');
    expect(text).toContain('1 — высокий поздний — 1-й день');
    expect(text.indexOf('высокий ранний')).toBeLessThan(text.indexOf('высокий поздний'));
    expect(text.indexOf('высокий поздний')).toBeLessThan(text.indexOf('обычный'));
    expect(text.indexOf('обычный')).toBeLessThan(text.indexOf('\n4 — низкий'));
    expect(text).toContain('high · в работу · отменить');
    expect(text).not.toContain('Чужой план');
    expect(text).not.toContain('Уже подтверждена');
    expect(text).not.toContain('○ 3 —');
    expect(text).not.toContain('✓');
  });

  it('INV-24 смена таймзоны не переписывает выставленный канвас; новые сутки дают другое сообщение', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    const input = {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      send: gate.send,
      edit: gate.edit,
    };
    const posted = await showCanvas(fixture.db, { ...input, now: noon, causationId: null });
    await setTimezone(fixture.db, fixture.alphaId, 'Pacific/Honolulu');
    const sameDay = await showCanvas(fixture.db, { ...input, now: noon, causationId: causationB });
    expect(sameDay.action).toBe('edit');
    expect(sameDay.canvas).toMatchObject({
      id: posted.canvas.id,
      messageId: posted.canvas.messageId,
      canvasDate: '2026-09-28',
    });
    await setTimezone(fixture.db, fixture.alphaId, 'Pacific/Kiritimati');
    const shifted = await showCanvas(fixture.db, { ...input, now: noon, causationId: null });
    expect(shifted.action).toBe('post');
    expect(shifted.canvas.canvasDate).toBe('2026-09-29');
    expect(gate.sent.map((item) => item.canvasDate)).toEqual(['2026-09-28', '2026-09-29']);
    expect(gate.edited.map((item) => item.home.canvasDate)).toEqual(['2026-09-28']);
    expect(gate.sent.every((item) => item.projectName === 'Альфа')).toBe(true);
    expect(gate.edited.every((item) => item.home.projectName === 'Альфа')).toBe(true);
    const rows = await canvasesOf(fixture.db);
    expect(rows).toEqual([
      {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        topicId: '42',
        messageId: String(posted.canvas.messageId),
        canvasDate: '2026-09-28',
      },
      {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        topicId: '42',
        messageId: String(shifted.canvas.messageId),
        canvasDate: '2026-09-29',
      },
    ]);
  });

  it('INV-24 планировщик ставит канвас на сегодня и не переписывает уже выставленный', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    await ensureTodayCanvases(fixture.db, noon, gate.send);
    expect(gate.sent).toEqual([shown('2026-09-28')]);
    const once = await canvasesOf(fixture.db);
    await ensureTodayCanvases(fixture.db, noon, gate.send);
    expect(gate.sent).toHaveLength(1);
    expect(await canvasesOf(fixture.db)).toEqual(once);
    expect(await eventTypes(fixture.db, EVENT_TYPES.CANVAS_EDITED)).toEqual([]);
    const nextDay = new Date('2026-09-28T21:00:00.000Z');
    await ensureTodayCanvases(fixture.db, nextDay, gate.send);
    expect(gate.sent).toEqual([shown('2026-09-28'), shown('2026-09-29')]);
    expect((await canvasesOf(fixture.db)).map((row) => row.canvasDate)).toEqual(['2026-09-28', '2026-09-29']);
  });

  it('R-106 задача появляется на канвасе', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    const redraw = {
      redraw(input: { projectId: string; assigneeId: string; causationId: string }) {
        return showCanvas(fixture.db, {
          projectId: input.projectId,
          assigneeId: input.assigneeId,
          destination: CANVAS_DESTINATION_TOPIC,
          now: noon,
          causationId: input.causationId,
          send: gate.send,
          edit: gate.edit,
        }).then(() => undefined);
      },
    };
    const reply = await replyToTaskCommand(
      { type: 'supergroup', id: telegramChatId, topicId: 42 },
      borisAccount,
      'appear',
      'Классификация сигнала',
      createTaskActions(fixture.db, clock),
      redraw,
    );
    expect(reply).toContain('Классификация сигнала');
    expect(gate.sent).toEqual([
      shown('2026-09-28', [openTask('Классификация сигнала')]),
    ]);
    const message = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: { tasks: tasksBlockParagraphs(gate.sent[0]?.tasks ?? []) },
    });
    expect(message.blocks.map((block) => visibleCanvas(block.text))).toEqual([
      'ПРОЕКТ: Альфа · 28.09',
      'Задачи',
      '○ 1 — Классификация сигнала — 1-й день\nnormal · в план · отменить',
    ]);
  });

  it('R-141 «Задачи» — то, что человек завёл в этом топике', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const vera = await sql<{ id: string }>`
      SELECT id::text AS id FROM users WHERE telegram_user_id = ${String(veraAccount.id)}::bigint
    `.execute(fixture.db);
    const veraId = vera.rows[0]?.id;
    if (veraId === undefined) throw new Error('Веры нет');
    await setTopic(fixture.db, veraId, 43);
    const actions = createTaskActions(fixture.db, clock);
    await actions.create({
      telegramUserId: String(borisAccount.id),
      chat: 'supergroup',
      telegramChatId,
      topicId: 42,
      title: 'Своя',
      idempotencyKey: 'boris-own',
    });
    await actions.create({
      telegramUserId: String(veraAccount.id),
      chat: 'supergroup',
      telegramChatId,
      topicId: 43,
      title: 'Чужая',
      idempotencyKey: 'vera-own',
    });
    const gate = io();
    await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    expect(gate.sent[0]?.tasks.map((task) => task.title)).toEqual(['Своя']);
    const lines = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: { tasks: tasksBlockParagraphs(gate.sent[0]?.tasks ?? []) },
    }).blocks.map((block) => block.text);
    expect(lines[1]).toBe('Задачи');
    expect(lines.join('\n')).toContain('Своя');
    expect(lines.join('\n')).not.toContain('Чужая');
    expect(lines.join('\n')).not.toContain('#40');
  });

  it('INV-22 повтор команды не добавляет вторую строку задачи на канвас', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    const actions = createTaskActions(fixture.db, clock);
    const redraw = {
      redraw(input: { projectId: string; assigneeId: string; causationId: string }) {
        return showCanvas(fixture.db, {
          projectId: input.projectId,
          assigneeId: input.assigneeId,
          destination: CANVAS_DESTINATION_TOPIC,
          now: noon,
          causationId: input.causationId,
          send: gate.send,
          edit: gate.edit,
        }).then(() => undefined);
      },
    };
    const place = { type: 'supergroup', id: telegramChatId, topicId: 42 };
    await replyToTaskCommand(place, borisAccount, 'once', 'Первая', actions, redraw);
    const again = await replyToTaskCommand(place, borisAccount, 'once', 'Вторая', actions, redraw);
    expect(again).toBeNull();
    expect(gate.sent).toHaveLength(1);
    expect(gate.sent[0]?.tasks).toEqual([openTask('Первая')]);
    expect(gate.edited).toEqual([]);
  });

  it('INV-23 отказ не создаёт второе сообщение и пишет canvas.full', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const gate = io();
    const cause = '9001';
    await expect(
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_TOPIC,
        now: noon,
        causationId: null,
        cause,
        send: async () => ({ status: 'full' }),
        edit: gate.edit,
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_FULL });
    expect(await canvasesOf(fixture.db)).toEqual([]);
    expect(gate.edited).toEqual([]);
    const full = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_FULL);
    expect(full).toHaveLength(1);
    expect(full[0]?.key).toBe(`${fixture.alphaId}+${fixture.borisId}+2026-09-28+${cause}`);
    expect(full[0]?.payload).toEqual({
      canvas_id: null,
      project_id: fixture.alphaId,
      assignee_id: fixture.borisId,
      canvas_date: '2026-09-28',
    });
    await expect(
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_TOPIC,
        now: noon,
        causationId: null,
        cause,
        send: async () => ({ status: 'full' }),
        edit: gate.edit,
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_DUPLICATE });
    expect(await canvasesOf(fixture.db)).toEqual([]);
  });

  it('INV-09 правка с ужатием не снимает задачи; отказ на правке не заводит второе сообщение', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const actions = createTaskActions(fixture.db, clock);
    await actions.create({
      telegramUserId: String(borisAccount.id),
      chat: 'supergroup',
      telegramChatId,
      topicId: 42,
      title: 'Остаётся',
      idempotencyKey: 'stay',
    });
    const gate = io();
    const posted = await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: null,
      send: gate.send,
      edit: gate.edit,
    });
    await showCanvas(fixture.db, {
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      now: noon,
      causationId: causationA,
      send: gate.send,
      edit: async () => ({ status: 'edited', shrunk: true }),
    });
    const edited = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_EDITED);
    expect(edited.map((row) => row.payload)).toEqual([{ canvas_id: posted.canvas.id, shrunk: true }]);
    expect(await taskStatuses(fixture.db)).toEqual([TASK_STATUS_IN_PROGRESS]);
    const before = await canvasesOf(fixture.db);
    await expect(
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_TOPIC,
        now: noon,
        causationId: causationB,
        cause: '9002',
        send: gate.send,
        edit: async () => ({ status: 'full' }),
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_FULL });
    expect(await canvasesOf(fixture.db)).toEqual(before);
    expect(await taskStatuses(fixture.db)).toEqual([TASK_STATUS_IN_PROGRESS]);
    const full = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_FULL);
    expect(full[0]?.payload).toMatchObject({ canvas_id: posted.canvas.id, canvas_date: '2026-09-28' });
  });

  it('INV-24 дата canvas.full — сутки проекта', async () => {
    const fixture = await seed(true);
    opened.push(fixture);
    await setTopic(fixture.db, fixture.borisId, 42);
    const edge = new Date('2026-09-28T21:30:00.000Z');
    const refuse = (cause: string) =>
      showCanvas(fixture.db, {
        projectId: fixture.alphaId,
        assigneeId: fixture.borisId,
        destination: CANVAS_DESTINATION_TOPIC,
        now: edge,
        causationId: null,
        cause,
        send: async () => ({ status: 'full' }),
        edit: async () => ({ status: 'full' }),
      });
    await expect(refuse('moscow')).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_FULL });
    await setTimezone(fixture.db, fixture.alphaId, 'Pacific/Honolulu');
    await expect(refuse('honolulu')).rejects.toMatchObject({ code: DOMAIN_ERROR.CANVAS_FULL });
    const full = await eventTypes(fixture.db, EVENT_TYPES.CANVAS_FULL);
    expect(full.map((row) => (row.payload as { canvas_date: string }).canvas_date).sort()).toEqual(['2026-09-28', '2026-09-29']);
    expect(await canvasesOf(fixture.db)).toEqual([]);
  });
});
