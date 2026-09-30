import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  carryCanvasPair,
  carriedCanvasKey,
  recordCanvasCarry,
  tasksForCarry,
  type CarryTask,
} from '../domain/tasks/carry-canvas.ts';
import { defineCanvas, type Canvas } from '../domain/tasks/canvas.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { projectCalendarDate } from '../domain/shared/project-time.ts';
import { taskPriority, taskStatus } from '../domain/tasks/status.ts';
import type { Logger } from '../domain/shared/logger.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

interface CanvasRow {
  id: string;
  project_id: string;
  assignee_id: string;
  topic_id: string;
  message_id: string;
  canvas_date: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  number: number | string;
  status: string;
  priority: string;
  assignee_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function whole(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} повреждён`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} повреждён`);
  return parsed;
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

function canvasOf(row: CanvasRow): Canvas {
  return defineCanvas({
    id: row.id,
    projectId: row.project_id,
    assigneeId: row.assignee_id,
    topicId: whole(row.topic_id, 'topic_id'),
    messageId: whole(row.message_id, 'message_id'),
    canvasDate: row.canvas_date.slice(0, 10),
  });
}

async function canvasesOf(
  db: Kysely<Database> | Transaction<Database>,
  projectId: string,
  assigneeId: string,
): Promise<Canvas[]> {
  const found = await sql<CanvasRow>`
    SELECT id::text AS id,
           project_id::text AS project_id,
           assignee_id::text AS assignee_id,
           topic_id::text AS topic_id,
           message_id::text AS message_id,
           canvas_date::text AS canvas_date
    FROM canvases
    WHERE project_id = ${projectId}::uuid
      AND assignee_id = ${assigneeId}::uuid
    ORDER BY canvas_date
  `.execute(db);
  return found.rows.map(canvasOf);
}

async function tasksOf(
  db: Kysely<Database> | Transaction<Database>,
  projectId: string,
  assigneeId: string,
  timezone: string,
): Promise<CarryTask[]> {
  const found = await sql<TaskRow>`
    SELECT id::text AS id,
           project_id::text AS project_id,
           number,
           status,
           priority,
           assignee_id::text AS assignee_id,
           created_at,
           updated_at
    FROM tasks
    WHERE project_id = ${projectId}::uuid
      AND assignee_id = ${assigneeId}::uuid
    ORDER BY number
  `.execute(db);
  return found.rows.map((row) => {
    const createdAt = instant(row.created_at).toISOString();
    return {
      id: row.id,
      projectId: row.project_id,
      assigneeId: row.assignee_id,
      number: taskNumber(row.number),
      status: taskStatus(row.status),
      priority: taskPriority(row.priority),
      createdAt,
      createdOn: projectCalendarDate(instant(row.created_at), timezone),
    };
  });
}

async function alreadyCarried(db: Kysely<Database> | Transaction<Database>, key: string): Promise<boolean> {
  const found = await sql<{ id: string }>`
    SELECT id::text AS id FROM events WHERE idempotency_key = ${key} LIMIT 1
  `.execute(db);
  return found.rows.length > 0;
}

/**
 * A-30 для одного исполнителя. «Сегодня» — сутки проекта.
 * Нет канваса на сегодня или нет более раннего — переноса нет.
 * Повтор того же дня не пишет второе событие и не добавляет пункты.
 */
export async function carryAssigneeDay(
  db: Kysely<Database>,
  logger: Logger,
  projectId: string,
  assigneeId: string,
  now: Date,
): Promise<void> {
  const projects = await sql<{ timezone: string }>`
    SELECT timezone FROM projects WHERE id = ${projectId}::uuid
  `.execute(db);
  const project = projects.rows[0];
  if (project === undefined) return;
  const today = projectCalendarDate(now, project.timezone);
  const canvases = await canvasesOf(db, projectId, assigneeId);
  const pair = carryCanvasPair(canvases, today);
  if (pair === null) return;
  const tasks = tasksForCarry(pair.from, pair.to, await tasksOf(db, projectId, assigneeId, project.timezone));
  if (tasks.length === 0) return;
  const key = carriedCanvasKey(pair.to.projectId, pair.to.assigneeId, pair.to.canvasDate);
  if (await alreadyCarried(db, key)) return;
  try {
    await db.transaction().execute(async (trx) => {
      if (await alreadyCarried(trx, key)) {
        throw new DomainError(DOMAIN_ERROR.CANVAS_DUPLICATE, 'canvas.carried_over уже записан');
      }
      await recordCanvasCarry(
        {
          async insert(item) {
            await sql`
              INSERT INTO canvas_items (id, canvas_id, task_id, position, carried_from_canvas_id)
              VALUES (
                ${item.id}::uuid,
                ${item.canvasId}::uuid,
                ${item.taskId}::uuid,
                ${item.position},
                ${item.carriedFromCanvasId}::uuid
              )
            `.execute(trx);
          },
        },
        createEventJournal(trx, logger),
        {
          from: pair.from,
          to: pair.to,
          tasks,
          itemIds: tasks.map(() => randomUUID()),
          occurredAt: now,
        },
      );
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === DOMAIN_ERROR.CANVAS_DUPLICATE) return;
    throw error;
  }
}

/** A-30 по всем канвасам. Сбой одного исполнителя не отменяет остальных, затем всплывает. */
export async function carryOpenCanvases(db: Kysely<Database>, logger: Logger, now: Date): Promise<void> {
  const pairs = await sql<{ project_id: string; assignee_id: string }>`
    SELECT DISTINCT project_id::text AS project_id, assignee_id::text AS assignee_id
    FROM canvases
    ORDER BY project_id::text, assignee_id::text
  `.execute(db);
  const failures: unknown[] = [];
  for (const pair of pairs.rows) {
    try {
      await carryAssigneeDay(db, logger, pair.project_id, pair.assignee_id, now);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('перенос дня не записан');
}
