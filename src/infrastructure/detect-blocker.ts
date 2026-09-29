import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { decideStaleBlock, type TaskJournalMark } from '../domain/tasks/detect-blocker.ts';
import { taskStatus } from '../domain/tasks/status.ts';
import { defineTask, type Task } from '../domain/tasks/task.ts';
import type { Database } from './database.ts';
import { commitBlockerDetected } from './tasks.ts';

/** Вопрос, который A-28 уже записал. Доставка — снаружи транзакции. */
export interface DetectedBlocker {
  projectId: string;
  assigneeId: string;
  taskId: string;
  eventId: string;
  telegramChatId: string;
  topicId: number;
  taskNumber: number;
  day: number;
}

interface CandidateRow {
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
  timezone: string;
  topic_id: string | null;
  telegram_chat_id: string | null;
}

interface MarkRow {
  event_type: string;
  created_at: Date | string;
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function iso(value: Date | string): string {
  return instant(value).toISOString();
}

function taskNumber(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error('номер задачи повреждён');
}

function topicId(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function taskOf(row: CandidateRow): Task {
  return defineTask({
    id: row.id,
    projectId: row.project_id,
    number: taskNumber(row.number),
    title: row.title,
    status: taskStatus(row.status),
    priority: row.priority,
    assigneeId: row.assignee_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  });
}

async function candidates(db: Kysely<Database> | Transaction<Database>): Promise<CandidateRow[]> {
  const found = await sql<CandidateRow>`
    SELECT tasks.id::text AS id,
           tasks.project_id::text AS project_id,
           tasks.number,
           tasks.title,
           tasks.status,
           tasks.priority,
           tasks.assignee_id::text AS assignee_id,
           tasks.created_at,
           tasks.updated_at,
           tasks.completed_at,
           projects.timezone,
           project_members.topic_id::text AS topic_id,
           chats.telegram_chat_id::text AS telegram_chat_id
    FROM tasks
    JOIN projects ON projects.id = tasks.project_id
    JOIN project_members
      ON project_members.project_id = tasks.project_id
     AND project_members.user_id = tasks.assignee_id
    LEFT JOIN chats ON chats.id = projects.chat_id
    WHERE tasks.status = 'IN_PROGRESS'
    ORDER BY tasks.id
  `.execute(db);
  return found.rows;
}

async function marksOf(db: Kysely<Database> | Transaction<Database>, taskId: string): Promise<TaskJournalMark[]> {
  const found = await sql<MarkRow>`
    SELECT event_type, created_at
    FROM events
    WHERE payload->>'task_id' = ${taskId}
    ORDER BY created_at, id
  `.execute(db);
  return found.rows.map((row) => ({ type: row.event_type, occurredAt: instant(row.created_at) }));
}

async function lockTask(trx: Transaction<Database>, taskId: string): Promise<CandidateRow | null> {
  const found = await sql<CandidateRow>`
    SELECT tasks.id::text AS id,
           tasks.project_id::text AS project_id,
           tasks.number,
           tasks.title,
           tasks.status,
           tasks.priority,
           tasks.assignee_id::text AS assignee_id,
           tasks.created_at,
           tasks.updated_at,
           tasks.completed_at,
           projects.timezone,
           project_members.topic_id::text AS topic_id,
           chats.telegram_chat_id::text AS telegram_chat_id
    FROM tasks
    JOIN projects ON projects.id = tasks.project_id
    JOIN project_members
      ON project_members.project_id = tasks.project_id
     AND project_members.user_id = tasks.assignee_id
    LEFT JOIN chats ON chats.id = projects.chat_id
    WHERE tasks.id = ${taskId}::uuid
    FOR UPDATE OF tasks
  `.execute(trx);
  return found.rows[0] ?? null;
}

async function detectOne(
  db: Kysely<Database>,
  taskId: string,
  now: Date,
): Promise<DetectedBlocker | null> {
  return db.transaction().execute(async (trx) => {
    const row = await lockTask(trx, taskId);
    if (row === null) return null;
    const topic = topicId(row.topic_id);
    const chatId = row.telegram_chat_id;
    if (topic === null || chatId === null || chatId.length === 0) return null;
    const task = taskOf(row);
    const decision = decideStaleBlock({
      status: task.status,
      taskId: task.id,
      createdAt: instant(task.createdAt),
      timezone: row.timezone,
      marks: await marksOf(trx, task.id),
      now,
    });
    if (decision === null) return null;
    const recorded = await commitBlockerDetected(trx, {
      task,
      blockerId: randomUUID(),
      day: decision.day,
      idempotencyKey: decision.idempotencyKey,
      occurredAt: now,
    });
    if (!recorded.applied) return null;
    return {
      projectId: task.projectId,
      assigneeId: task.assigneeId,
      taskId: task.id,
      eventId: recorded.eventId,
      telegramChatId: chatId,
      topicId: topic,
      taskNumber: task.number,
      day: decision.day,
    };
  });
}

/**
 * A-28 по всем `IN_PROGRESS`. Сбой одной задачи не отменяет остальные, затем всплывает.
 * Без топика исполнителя вопрос некуда писать — задача остаётся как была.
 */
export async function detectStaleTasks(
  db: Kysely<Database>,
  now: Date,
  notify: (hit: DetectedBlocker) => Promise<void>,
): Promise<void> {
  const rows = await candidates(db);
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      const hit = await detectOne(db, row.id, now);
      if (hit === null) continue;
      await notify(hit);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('застой не записан');
}
