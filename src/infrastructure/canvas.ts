import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { carryAssigneeDay } from './carry-canvas.ts';
import {
  CANVAS_DESTINATION_TOPIC,
  decideCanvasMove,
  recordEditedCanvas,
  recordPostedCanvas,
  requireEditCausation,
  type CanvasSlotState,
} from '../domain/tasks/place-canvas.ts';
import type { Canvas } from '../domain/tasks/canvas.ts';
import type { Clock } from '../domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { projectCalendarDate } from '../domain/shared/project-time.ts';
import { tasksBlock } from '../domain/tasks/github-link.ts';
import { orderPlan, taskPriority, taskStatus, tasksStandingInBlock } from '../domain/tasks/status.ts';
import { taskCanvasDay } from '../domain/tasks/task-day.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

/** Задача на канвасе этого исполнителя: первая строка абзаца и приоритет для второй. */
export interface CanvasTaskLine {
  number: number;
  title: string;
  status: string;
  day: number;
  priority: string;
}

export interface CanvasHome {
  telegramChatId: string;
  topicId: number;
  projectName: string;
  canvasDate: string;
  tasks: readonly CanvasTaskLine[];
  plan: readonly CanvasTaskLine[];
}

export interface ShownCanvas {
  action: 'post' | 'edit';
  canvas: Canvas;
}

export interface ShowCanvasInput {
  projectId: string;
  assigneeId: string;
  destination: string;
  now: Date;
  causationId: string | null;
  send(home: CanvasHome): Promise<number>;
  edit(home: CanvasHome, messageId: number): Promise<void>;
}

interface SlotRow {
  timezone: string;
  telegram_chat_id: string | null;
  topic_id: string | null;
}

interface CanvasRow {
  id: string;
  topic_id: string;
  message_id: string;
  canvas_date: string;
}

interface MemberRow {
  project_id: string;
  user_id: string;
  topic_id: string;
  timezone: string;
  project_name: string;
  telegram_chat_id: string;
}

function whole(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} повреждён`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} повреждён`);
  return parsed;
}

function day(value: string): string {
  return value.slice(0, 10);
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function taskNumber(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error('номер задачи повреждён');
}

interface AssigneeTaskRow {
  id: string;
  project_id: string;
  number: number | string;
  title: string;
  status: string;
  priority: string;
  assignee_id: string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

function taskLine(
  task: { number: number; title: string; status: string; priority: string; createdAt: string },
  canvasDate: string,
  timezone: string,
): CanvasTaskLine {
  return {
    number: task.number,
    title: task.title,
    status: task.status,
    day: taskCanvasDay(projectCalendarDate(instant(task.createdAt), timezone), canvasDate),
    priority: task.priority,
  };
}

/**
 * Задачи этого человека на канвасе.
 * «Задачи» — `IN_PROGRESS`, `BLOCKED`, `REVIEW`. «План» — его `PLANNED` в порядке `orderPlan`.
 * Факты GitHub, подтверждённое и снятое строку не занимают.
 */
async function assigneeCanvasLines(
  db: Kysely<Database> | Transaction<Database>,
  projectId: string,
  assigneeId: string,
  canvasDate: string,
  timezone: string,
): Promise<{ tasks: CanvasTaskLine[]; plan: CanvasTaskLine[] }> {
  const found = await sql<AssigneeTaskRow>`
    SELECT id::text AS id,
           project_id::text AS project_id,
           number,
           title,
           status,
           priority,
           assignee_id::text AS assignee_id,
           created_at,
           updated_at,
           completed_at
    FROM tasks
    WHERE project_id = ${projectId}::uuid
      AND assignee_id = ${assigneeId}::uuid
    ORDER BY number
  `.execute(db);
  const visible = tasksBlock(
    found.rows.map((row) => ({
      source: 'task' as const,
      task: {
        id: row.id,
        projectId: row.project_id,
        number: taskNumber(row.number),
        title: row.title,
        status: taskStatus(row.status),
        priority: taskPriority(row.priority),
        assigneeId: row.assignee_id,
        createdAt: instant(row.created_at).toISOString(),
        updatedAt: instant(row.updated_at).toISOString(),
        completedAt: row.completed_at === null ? null : instant(row.completed_at).toISOString(),
      },
    })),
  );
  return {
    tasks: tasksStandingInBlock(visible).map((task) => taskLine(task, canvasDate, timezone)),
    plan: orderPlan(visible).map((task) => taskLine(task, canvasDate, timezone)),
  };
}

function canvasOf(row: CanvasRow, projectId: string, assigneeId: string): Canvas {
  return {
    id: row.id,
    projectId,
    assigneeId,
    topicId: whole(row.topic_id, 'topic_id'),
    messageId: whole(row.message_id, 'message_id'),
    canvasDate: day(row.canvas_date),
  };
}

async function readCanvas(
  db: Kysely<Database> | Transaction<Database>,
  projectId: string,
  assigneeId: string,
  canvasDate: string,
): Promise<Canvas | null> {
  const found = await sql<CanvasRow>`
    SELECT id::text AS id,
           topic_id::text AS topic_id,
           message_id::text AS message_id,
           canvas_date::text AS canvas_date
    FROM canvases
    WHERE project_id = ${projectId}::uuid
      AND assignee_id = ${assigneeId}::uuid
      AND canvas_date = ${canvasDate}::date
  `.execute(db);
  const row = found.rows[0];
  if (row === undefined) return null;
  return canvasOf(row, projectId, assigneeId);
}

/** Слот на уже посчитанную дату: канвас этой даты или пусто. */
async function slotFor(
  db: Kysely<Database>,
  projectId: string,
  assigneeId: string,
  canvasDate: string,
): Promise<CanvasSlotState> {
  const found = await sql<SlotRow>`
    SELECT projects.timezone AS timezone,
           chats.telegram_chat_id::text AS telegram_chat_id,
           project_members.topic_id::text AS topic_id
    FROM projects
    JOIN project_members
      ON project_members.project_id = projects.id
     AND project_members.user_id = ${assigneeId}::uuid
    LEFT JOIN chats ON chats.id = projects.chat_id
    WHERE projects.id = ${projectId}::uuid
  `.execute(db);
  if (found.rows.length > 1) throw new DomainError(DOMAIN_ERROR.CANVAS_AMBIGUOUS, 'топик совпал у нескольких проектов');
  const row = found.rows[0];
  if (row === undefined) throw new DomainError(DOMAIN_ERROR.CANVAS_PROJECT_MISSING, 'проекта или исполнителя нет');
  const telegramChatId = row.telegram_chat_id;
  return {
    timezone: row.timezone,
    bound: telegramChatId !== null && telegramChatId.trim().length > 0,
    telegramChatId,
    topicId: row.topic_id === null ? null : whole(row.topic_id, 'topic_id'),
    existing: await readCanvas(db, projectId, assigneeId, canvasDate),
  };
}

/** После выставления: незакрытые задачи прошлого канваса ложатся на сегодня, если сутки уже новые. */
async function finish(
  db: Kysely<Database>,
  projectId: string,
  assigneeId: string,
  now: Date,
  shown: ShownCanvas,
): Promise<ShownCanvas> {
  await carryAssigneeDay(db, projectId, assigneeId, now);
  return shown;
}

/**
 * Выставить канвас на дату `now` в таймзоне проекта.
 * Нет строки — новое сообщение и `canvas.posted`. Есть — правка того же `message_id` и `canvas.edited`.
 */
export async function showCanvas(db: Kysely<Database>, input: ShowCanvasInput): Promise<ShownCanvas> {
  const preview = await sql<{ timezone: string; name: string }>`
    SELECT timezone, name FROM projects WHERE id = ${input.projectId}::uuid
  `.execute(db);
  const project = preview.rows[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.CANVAS_PROJECT_MISSING, 'проекта или исполнителя нет');
  const canvasDate = projectCalendarDate(input.now, project.timezone);
  const slot = await slotFor(db, input.projectId, input.assigneeId, canvasDate);
  const move = decideCanvasMove(input.destination, slot, input.now);
  const lines = await assigneeCanvasLines(db, input.projectId, input.assigneeId, canvasDate, project.timezone);
  if (move.kind === 'edit') {
    const causationId = requireEditCausation(input.causationId);
    const telegramChatId = slot.telegramChatId ?? '';
    await input.edit(
      {
        telegramChatId,
        topicId: move.canvas.topicId,
        projectName: project.name,
        canvasDate: move.canvas.canvasDate,
        tasks: lines.tasks,
        plan: lines.plan,
      },
      move.canvas.messageId,
    );
    const canvas = await db.transaction().execute((trx) =>
      recordEditedCanvas(createEventJournal(trx), {
        canvas: move.canvas,
        causationId,
        occurredAt: input.now,
      }),
    );
    return finish(db, input.projectId, input.assigneeId, input.now, { action: 'edit', canvas });
  }
  const messageId = await input.send({
    telegramChatId: move.telegramChatId,
    topicId: move.topicId,
    projectName: project.name,
    canvasDate: move.canvasDate,
    tasks: lines.tasks,
    plan: lines.plan,
  });
  const canvas = await db.transaction().execute((trx) =>
    recordPostedCanvas(
      {
        async insert(row) {
          await sql`
            INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
            VALUES (
              ${row.id}::uuid,
              ${row.projectId}::uuid,
              ${row.assigneeId}::uuid,
              ${row.topicId},
              ${row.messageId},
              ${row.canvasDate}::date
            )
          `.execute(trx);
        },
      },
      createEventJournal(trx),
      {
        id: randomUUID(),
        projectId: input.projectId,
        assigneeId: input.assigneeId,
        topicId: move.topicId,
        messageId,
        canvasDate: move.canvasDate,
        occurredAt: input.now,
      },
    ),
  );
  return finish(db, input.projectId, input.assigneeId, input.now, { action: 'post', canvas });
}

/** Топик только что указан: канвас этого исполнителя на сегодня. */
export async function showCanvasForTopic(
  db: Kysely<Database>,
  input: {
    telegramUserId: string;
    topicId: number;
    now: Date;
    causationId: string | null;
    send: ShowCanvasInput['send'];
    edit: ShowCanvasInput['edit'];
  },
): Promise<ShownCanvas> {
  const found = await sql<{ project_id: string; user_id: string }>`
    SELECT project_members.project_id::text AS project_id,
           project_members.user_id::text AS user_id
    FROM project_members
    JOIN users ON users.id = project_members.user_id
    WHERE users.telegram_user_id = ${input.telegramUserId}::bigint
      AND project_members.topic_id = ${input.topicId}
  `.execute(db);
  if (found.rows.length !== 1) {
    throw new DomainError(
      found.rows.length === 0 ? DOMAIN_ERROR.CANVAS_NO_TOPIC : DOMAIN_ERROR.CANVAS_AMBIGUOUS,
      found.rows.length === 0 ? 'канвас живёт в топике исполнителя' : 'топик совпал у нескольких проектов',
    );
  }
  const row = found.rows[0];
  if (row === undefined) throw new DomainError(DOMAIN_ERROR.CANVAS_NO_TOPIC, 'канвас живёт в топике исполнителя');
  return showCanvas(db, {
    projectId: row.project_id,
    assigneeId: row.user_id,
    destination: CANVAS_DESTINATION_TOPIC,
    now: input.now,
    causationId: input.causationId,
    send: input.send,
    edit: input.edit,
  });
}

/**
 * Новые сутки: у кого топик и привязанная группа, а канваса на сегодня нет — новое сообщение.
 * Уже выставленный канвас не переписывается.
 */
export async function ensureTodayCanvases(
  db: Kysely<Database>,
  now: Date,
  send: (home: CanvasHome) => Promise<number>,
): Promise<void> {
  const members = await sql<MemberRow>`
    SELECT project_members.project_id::text AS project_id,
           project_members.user_id::text AS user_id,
           project_members.topic_id::text AS topic_id,
           projects.timezone AS timezone,
           projects.name AS project_name,
           chats.telegram_chat_id::text AS telegram_chat_id
    FROM project_members
    JOIN projects ON projects.id = project_members.project_id
    JOIN chats ON chats.id = projects.chat_id
    WHERE project_members.topic_id IS NOT NULL
    ORDER BY project_members.id
  `.execute(db);
  const failures: unknown[] = [];
  for (const member of members.rows) {
    try {
      const canvasDate = projectCalendarDate(now, member.timezone);
      const existing = await readCanvas(db, member.project_id, member.user_id, canvasDate);
      if (existing !== null) continue;
      const topicId = whole(member.topic_id, 'topic_id');
      const lines = await assigneeCanvasLines(db, member.project_id, member.user_id, canvasDate, member.timezone);
      const messageId = await send({
        telegramChatId: member.telegram_chat_id,
        topicId,
        projectName: member.project_name,
        canvasDate,
        tasks: lines.tasks,
        plan: lines.plan,
      });
      await db.transaction().execute((trx) =>
        recordPostedCanvas(
          {
            async insert(row) {
              await sql`
                INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
                VALUES (
                  ${row.id}::uuid,
                  ${row.projectId}::uuid,
                  ${row.assigneeId}::uuid,
                  ${row.topicId},
                  ${row.messageId},
                  ${row.canvasDate}::date
                )
              `.execute(trx);
            },
          },
          createEventJournal(trx),
          {
            id: randomUUID(),
            projectId: member.project_id,
            assigneeId: member.user_id,
            topicId,
            messageId,
            canvasDate,
            occurredAt: now,
          },
        ),
      );
      await carryAssigneeDay(db, member.project_id, member.user_id, now);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const first = failures[0];
    if (first instanceof Error) throw first;
    throw new Error('канвас на сегодня не выставлен');
  }
}

export interface CanvasPlacement {
  show(input: Omit<ShowCanvasInput, 'now'> & { now?: Date }): Promise<ShownCanvas>;
  showForTopic(input: Omit<Parameters<typeof showCanvasForTopic>[1], 'now'>): Promise<ShownCanvas>;
  ensureToday(now: Date, send: (home: CanvasHome) => Promise<number>): Promise<void>;
}

/** Часы — только момент «сегодня». Дата канваса считается по таймзоне проекта. */
export function createCanvasPlacement(db: Kysely<Database>, clock: Clock): CanvasPlacement {
  return {
    show(input) {
      return showCanvas(db, { ...input, now: input.now ?? clock.now() });
    },
    showForTopic(input) {
      return showCanvasForTopic(db, { ...input, now: clock.now() });
    },
    ensureToday(now, send) {
      return ensureTodayCanvases(db, now, send);
    },
  };
}
