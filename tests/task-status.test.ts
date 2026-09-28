import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_DAYS } from '../src/config/constants.ts';
import { defineTask, type Task } from '../src/domain/tasks/task.ts';
import {
  blockedByListSilence,
  TASK_PRIORITIES,
  TASK_PRIORITY_HIGH,
  TASK_PRIORITY_LOW,
  TASK_PRIORITY_NORMAL,
  TASK_STATUSES,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  taskPriority,
  taskStatus,
} from '../src/domain/tasks/status.ts';
import { projectDaysBetween } from '../src/domain/shared/project-time.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readProjectsMigration, readTasksMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';

const base: Task = {
  id: '00000000-0000-4000-8000-0000000000b1',
  projectId,
  number: 1,
  title: 'Сверстать отчёт',
  status: TASK_STATUS_IN_PROGRESS,
  priority: TASK_PRIORITY_NORMAL,
  assigneeId: userId,
  createdAt: '2026-09-28T07:33:00.000Z',
  updatedAt: '2026-09-28T09:00:00.000Z',
  completedAt: null,
};

async function openTasks(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
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

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${userId}::uuid, 1001, 'Аня', true)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, '2026-09-28T07:33:00.000Z'::timestamptz)
  `.execute(db);
}

async function insertRaw(
  db: Kysely<Database>,
  row: { id: string; status: string; priority: string; number: number },
): Promise<void> {
  await sql`
    INSERT INTO tasks (
      id, project_id, number, title, status, priority, assignee_id, created_at, updated_at
    )
    VALUES (
      ${row.id}::uuid,
      ${projectId}::uuid,
      ${row.number},
      'Сверстать отчёт',
      ${row.status},
      ${row.priority},
      ${userId}::uuid,
      '2026-09-28T07:33:00.000Z'::timestamptz,
      '2026-09-28T09:00:00.000Z'::timestamptz
    )
  `.execute(db);
}

describe('E-5 статусы, приоритеты и ключ tasks', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-5 статусы: PLANNED, IN_PROGRESS, BLOCKED, REVIEW, DONE, CANCELLED', () => {
    expect(TASK_STATUSES).toEqual([
      TASK_STATUS_PLANNED,
      TASK_STATUS_IN_PROGRESS,
      TASK_STATUS_BLOCKED,
      TASK_STATUS_REVIEW,
      TASK_STATUS_DONE,
      TASK_STATUS_CANCELLED,
    ]);
    for (const status of TASK_STATUSES) {
      expect(taskStatus(status)).toBe(status);
      expect(defineTask({ ...base, status }).status).toBe(status);
    }
    for (const status of ['planned', 'IN PROGRESS', 'waiting', 'DONE ', 'blocked']) {
      expect(() => taskStatus(status)).toThrow(DomainError);
      expect(() => taskStatus(status)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_STATUS }));
      expect(() => defineTask({ ...base, status })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_STATUS }));
    }
  });

  it('E-5 приоритеты: high, normal, low', () => {
    expect(TASK_PRIORITIES).toEqual([TASK_PRIORITY_HIGH, TASK_PRIORITY_NORMAL, TASK_PRIORITY_LOW]);
    for (const priority of TASK_PRIORITIES) {
      expect(taskPriority(priority)).toBe(priority);
      expect(defineTask({ ...base, priority }).priority).toBe(priority);
    }
    for (const priority of ['HIGH', 'urgent', 'medium', 'normal ']) {
      expect(() => taskPriority(priority)).toThrow(DomainError);
      expect(() => taskPriority(priority)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_PRIORITY }));
      expect(() => defineTask({ ...base, priority })).toThrow(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_PRIORITY }),
      );
    }
  });

  it('E-5 BLOCKED — сутки в списке без галочки не меньше STALE_DAYS', () => {
    const earlier = new Date('2026-09-27T20:00:00.000Z');
    const later = new Date('2026-09-28T22:00:00.000Z');
    expect(projectDaysBetween(earlier, later, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(blockedByListSilence(earlier, later, 'Europe/Moscow')).toBe(true);
    expect(projectDaysBetween(earlier, later, 'Etc/UTC')).toBe(STALE_DAYS - 1);
    expect(blockedByListSilence(earlier, later, 'Etc/UTC')).toBe(false);
  });

  it('E-5 ключ таблицы tasks — id', async () => {
    const handle = await openTasks();
    opened.push(handle);
    const key = await sql<{ column_name: string }>`
      SELECT kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'tasks'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `.execute(handle.db);
    expect(key.rows.map((row) => row.column_name)).toEqual(['id']);
  });

  it('E-5 constraint статуса и приоритета: постороннее значение не пишется', async () => {
    const handle = await openTasks();
    opened.push(handle);
    await seed(handle.db);
    for (const [index, status] of TASK_STATUSES.entries()) {
      const id = `00000000-0000-4000-8000-0000000000c${index}`;
      await insertRaw(handle.db, { id, status, priority: TASK_PRIORITY_NORMAL, number: index + 1 });
    }
    for (const [index, priority] of TASK_PRIORITIES.entries()) {
      const id = `00000000-0000-4000-8000-0000000000d${index}`;
      await insertRaw(handle.db, { id, status: TASK_STATUS_PLANNED, priority, number: TASK_STATUSES.length + index + 1 });
    }
    await expect(
      insertRaw(handle.db, { id: '00000000-0000-4000-8000-0000000000e1', status: 'waiting', priority: 'normal', number: 20 }),
    ).rejects.toThrow(/tasks_status|23514/);
    await expect(
      insertRaw(handle.db, { id: '00000000-0000-4000-8000-0000000000e2', status: 'PLANNED', priority: 'urgent', number: 21 }),
    ).rejects.toThrow(/tasks_priority|23514/);
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM tasks`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(TASK_STATUSES.length + TASK_PRIORITIES.length);
  });
});
