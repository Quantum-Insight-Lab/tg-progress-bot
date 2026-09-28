import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { LEAD_ROLE } from '../domain/projects/member.ts';
import {
  pressTaskMark,
  type TaskMarkDraft,
  type TaskMarking,
  type TaskMarkResult,
  type TaskMarkStore,
} from '../domain/tasks/check-task.ts';
import {
  pressTaskReview,
  type TaskReviewing,
  type TaskReviewPress,
  type TaskReviewResult,
  type TaskReviewStore,
} from '../domain/tasks/review-task.ts';
import {
  createTask as decideCreate,
  type CreatedTask,
  type TaskCreation,
  type TaskDraft,
  type TaskStore,
  type TopicOwner,
} from '../domain/tasks/create-task.ts';
import { defineTask, type Task } from '../domain/tasks/task.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

async function findSender(trx: Transaction<Database>, telegramUserId: string): Promise<{ id: string } | null> {
  const row = await trx.selectFrom('users').select(['id']).where('telegram_user_id', '=', telegramUserId).executeTakeFirst();
  if (row === undefined) return null;
  return { id: row.id };
}

function storeOf(trx: Transaction<Database>): TaskStore {
  return {
    async ownersOfTopic(telegramChatId, topicId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('projects', 'projects.id', 'project_members.project_id')
        .innerJoin('chats', 'chats.id', 'projects.chat_id')
        .select(['project_members.project_id', 'project_members.user_id', 'project_members.role'])
        .where('chats.telegram_chat_id', '=', telegramChatId)
        .where('project_members.topic_id', '=', String(topicId))
        .orderBy('project_members.id')
        .execute();
      const owners: TopicOwner[] = rows.map((row) => ({
        projectId: row.project_id,
        userId: row.user_id,
        role: row.role,
      }));
      return owners;
    },
    async nextNumber(projectId) {
      const row = await trx
        .selectFrom('tasks')
        .select('number')
        .where('project_id', '=', projectId)
        .orderBy('number', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      const current = row?.number ?? 0;
      return current + 1;
    },
    async insert(task) {
      await trx
        .insertInto('tasks')
        .values({
          id: task.id,
          project_id: task.projectId,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignee_id: task.assigneeId,
          created_at: new Date(task.createdAt),
          updated_at: new Date(task.updatedAt),
          completed_at: task.completedAt === null ? null : new Date(task.completedAt),
        })
        .execute();
    },
  };
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function wholeNumber(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  throw new Error('номер задачи повреждён');
}

interface TaskRow {
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

function taskFromRow(row: TaskRow): Task {
  return defineTask({
    id: row.id,
    projectId: row.project_id,
    number: wholeNumber(row.number),
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  });
}

function markStore(trx: Transaction<Database>): TaskMarkStore {
  return {
    async sender(telegramUserId) {
      return findSender(trx, telegramUserId);
    },
    tasksInTopic(telegramChatId, topicId, taskNumber) {
      return lockTasksInTopic(trx, telegramChatId, topicId, taskNumber);
    },
    async saveStatus(task, from) {
      return writeStatus(trx, task, from);
    },
  };
}

async function writeStatus(trx: Transaction<Database>, task: Task, from: Task['status']): Promise<boolean> {
  const updated = await trx
    .updateTable('tasks')
    .set({
      status: task.status,
      updated_at: new Date(task.updatedAt),
      completed_at: task.completedAt === null ? null : new Date(task.completedAt),
    })
    .where('id', '=', task.id)
    .where('status', '=', from)
    .executeTakeFirst();
  return updated.numUpdatedRows > 0n;
}

function lockTasksInTopic(trx: Transaction<Database>, telegramChatId: string, topicId: number, taskNumber: number): Promise<Task[]> {
  return trx
    .selectFrom('tasks')
    .innerJoin('projects', 'projects.id', 'tasks.project_id')
    .innerJoin('chats', 'chats.id', 'projects.chat_id')
    .innerJoin('project_members', (join) =>
      join
        .onRef('project_members.project_id', '=', 'tasks.project_id')
        .onRef('project_members.user_id', '=', 'tasks.assignee_id'),
    )
    .select([
      'tasks.id',
      'tasks.project_id',
      'tasks.number',
      'tasks.title',
      'tasks.status',
      'tasks.priority',
      'tasks.assignee_id',
      'tasks.created_at',
      'tasks.updated_at',
      'tasks.completed_at',
    ])
    .where('chats.telegram_chat_id', '=', telegramChatId)
    .where('project_members.topic_id', '=', String(topicId))
    .where('tasks.number', '=', taskNumber)
    .orderBy('tasks.id')
    .forUpdate()
    .execute()
    .then((rows) => rows.map((row) => taskFromRow(row)));
}

function reviewStore(trx: Transaction<Database>): TaskReviewStore {
  return {
    async sender(telegramUserId) {
      return findSender(trx, telegramUserId);
    },
    tasksInTopic(telegramChatId, topicId, taskNumber) {
      return lockTasksInTopic(trx, telegramChatId, topicId, taskNumber);
    },
    async membership(projectId, userId) {
      const row = await trx
        .selectFrom('project_members')
        .select(['role'])
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { role: row.role };
    },
    async leadCount(projectId) {
      const result = await sql<{ n: number | string }>`
        SELECT CAST(count(*) AS int) AS n
        FROM project_members
        WHERE project_id = ${projectId}::uuid AND role = ${LEAD_ROLE}
      `.execute(trx);
      return Number(result.rows[0]?.n ?? 0);
    },
    async openBlocker(taskId) {
      // Строку `blockers` пишет акт блокера. Пока её нет, открытого блокера нет.
      void taskId;
      return false;
    },
    async seen(idempotencyKey) {
      const row = await trx
        .selectFrom('events')
        .select(['id'])
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { eventId: row.id };
    },
    saveStatus(task, from) {
      return writeStatus(trx, task, from);
    },
  };
}

/** «Подтвердить» и «вернуть»: статус и событие коммитятся одной транзакцией. */
export function createTaskReviewActions(db: Kysely<Database>, clock: Clock): TaskReviewing {
  return {
    press(input: TaskReviewPress): Promise<TaskReviewResult> {
      return db.transaction().execute((trx) => pressTaskReview(reviewStore(trx), createEventJournal(trx), clock, input));
    },
  };
}

/** Нажатие кружка: статус и `task.checked` или `task.unchecked` коммитятся одной транзакцией. */
export function createTaskMarkActions(db: Kysely<Database>, clock: Clock): TaskMarking {
  return {
    press(input: TaskMarkDraft): Promise<TaskMarkResult> {
      return db.transaction().execute((trx) => pressTaskMark(markStore(trx), createEventJournal(trx), clock, input));
    },
  };
}

/** `/task`: строка `tasks` и `task.created` коммитятся одной транзакцией. */
export function createTaskActions(db: Kysely<Database>, clock: Clock): TaskCreation {
  return {
    create(input: TaskDraft): Promise<CreatedTask> {
      return db.transaction().execute(async (trx) => {
        const sender = await findSender(trx, input.telegramUserId);
        return decideCreate(storeOf(trx), createEventJournal(trx), clock, {
          id: randomUUID(),
          title: input.title,
          sender,
          chat: input.chat,
          telegramChatId: input.telegramChatId,
          topicId: input.topicId,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
