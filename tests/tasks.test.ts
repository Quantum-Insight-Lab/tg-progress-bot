import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTask, type Task } from '../src/domain/tasks/task.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readProjectsMigration, readTasksMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';
const otherUserId = '00000000-0000-4000-8000-000000000002';

const openTask: Task = {
  id: '00000000-0000-4000-8000-0000000000b1',
  projectId,
  number: 7,
  title: 'Сверстать отчёт',
  status: 'IN_PROGRESS',
  priority: 'normal',
  assigneeId: userId,
  createdAt: '2026-09-28T07:33:00.000Z',
  updatedAt: '2026-09-28T09:00:00.000Z',
  completedAt: null,
};

const doneTask: Task = {
  id: '00000000-0000-4000-8000-0000000000b2',
  projectId: otherProjectId,
  number: 7,
  title: 'Закрыть счёт',
  status: 'DONE',
  priority: 'high',
  assigneeId: otherUserId,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-28T10:00:00.000Z',
  completedAt: '2026-09-28T10:00:00.000Z',
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
    VALUES
      (${userId}::uuid, 1001, 'Аня', true),
      (${otherUserId}::uuid, 1002, 'Борис', false)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES
      (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, '2026-09-28T07:33:00.000Z'::timestamptz),
      (${otherProjectId}::uuid, 'Бета', '', 'Europe/Moscow', NULL, '2026-09-28T08:00:00.000Z'::timestamptz)
  `.execute(db);
}

async function insertTask(
  db: Kysely<Database>,
  task: {
    id: string;
    projectId: string;
    number: number;
    title: string;
    status: string;
    priority: string;
    assigneeId: string;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO tasks (
      id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at
    )
    VALUES (
      ${task.id}::uuid,
      ${task.projectId}::uuid,
      ${task.number},
      ${task.title},
      ${task.status},
      ${task.priority},
      ${task.assigneeId}::uuid,
      ${task.createdAt}::timestamptz,
      ${task.updatedAt}::timestamptz,
      ${task.completedAt}::timestamptz
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tasks'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('E-5 задача — таблица tasks', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-5 поля задачи: номер, название, проект, приоритет, исполнитель, статус и даты', async () => {
    const task = defineTask(openTask);
    expect(task).toEqual(openTask);
    expect(task.completedAt).toBeNull();
    expect(defineTask(doneTask).completedAt).toBe(doneTask.completedAt);

    const handle = await openTasks();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'assignee_id',
      'completed_at',
      'created_at',
      'id',
      'number',
      'priority',
      'project_id',
      'status',
      'title',
      'updated_at',
    ]);
    await seed(handle.db);
    await insertTask(handle.db, task);
    await insertTask(handle.db, defineTask(doneTask));
    const rows = await sql<{
      id: string;
      project_id: string;
      number: number;
      title: string;
      status: string;
      priority: string;
      assignee_id: string;
      created_at: Date;
      updated_at: Date;
      completed_at: Date | null;
    }>`
      SELECT
        id::text AS id,
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
      ORDER BY title
    `.execute(handle.db);
    expect(rows.rows.map((row) => row.title)).toEqual([doneTask.title, openTask.title]);
    const stored = rows.rows.find((row) => row.id === openTask.id);
    expect(stored).toMatchObject({
      id: openTask.id,
      project_id: projectId,
      number: 7,
      title: openTask.title,
      status: 'IN_PROGRESS',
      priority: 'normal',
      assignee_id: userId,
      completed_at: null,
    });
    expect(stored?.created_at.toISOString()).toBe(openTask.createdAt);
    expect(stored?.updated_at.toISOString()).toBe(openTask.updatedAt);
    const finished = rows.rows.find((row) => row.id === doneTask.id);
    expect(finished?.completed_at?.toISOString()).toBe(doneTask.completedAt);
    expect(finished?.project_id).toBe(otherProjectId);
    expect(finished?.number).toBe(openTask.number);
  });

  it('E-5 ключ — id; проект и исполнитель обязательны и ссылаются на свои строки', async () => {
    const handle = await openTasks();
    opened.push(handle);
    await seed(handle.db);
    await insertTask(handle.db, defineTask(openTask));
    await expect(insertTask(handle.db, defineTask({ ...doneTask, id: openTask.id, projectId }))).rejects.toThrow(
      /duplicate key|23505|tasks_pkey/,
    );

    const missingProject = sql`
      INSERT INTO tasks (id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES (
        ${doneTask.id}::uuid,
        ${doneTask.number},
        ${doneTask.title},
        ${doneTask.status},
        ${doneTask.priority},
        ${otherUserId}::uuid,
        ${doneTask.createdAt}::timestamptz,
        ${doneTask.updatedAt}::timestamptz
      )
    `.execute(handle.db);
    await expect(missingProject).rejects.toThrow(/project_id|23502/);

    const unknownProject = insertTask(handle.db, {
      ...doneTask,
      projectId: '00000000-0000-4000-8000-000000000099',
    });
    await expect(unknownProject).rejects.toThrow(/tasks_project_id_fkey|23503/);

    const unknownAssignee = insertTask(handle.db, {
      ...doneTask,
      assigneeId: '00000000-0000-4000-8000-000000000098',
    });
    await expect(unknownAssignee).rejects.toThrow(/tasks_assignee_id_fkey|23503/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM tasks`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('E-5 название, статус и приоритет не пустые; даты создания и изменения обязательны; завершение может быть пустым', async () => {
    expect(() => defineTask({ ...openTask, id: ' ' })).toThrow(DomainError);
    expect(() => defineTask({ ...openTask, id: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_ID_BLANK }));
    expect(() => defineTask({ ...openTask, projectId: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_PROJECT_BLANK }),
    );
    expect(() => defineTask({ ...openTask, number: 1.5 })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_NUMBER }));
    expect(() => defineTask({ ...openTask, title: '   ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TITLE_BLANK }),
    );
    expect(() => defineTask({ ...openTask, status: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_STATUS_BLANK }),
    );
    expect(() => defineTask({ ...openTask, priority: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_PRIORITY_BLANK }),
    );
    expect(() => defineTask({ ...openTask, assigneeId: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_ASSIGNEE_BLANK }),
    );
    expect(() => defineTask({ ...openTask, createdAt: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_CREATED_AT_BLANK }),
    );
    expect(() => defineTask({ ...openTask, updatedAt: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_UPDATED_AT_BLANK }),
    );
    expect(() => defineTask({ ...openTask, completedAt: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_COMPLETED_AT_BLANK }),
    );

    const handle = await openTasks();
    opened.push(handle);
    await seed(handle.db);
    await expect(insertTask(handle.db, { ...openTask, title: '   ' })).rejects.toThrow(/tasks_title_not_blank|23514/);
    await expect(insertTask(handle.db, { ...openTask, status: ' ' })).rejects.toThrow(/tasks_status|23514/);
    await expect(insertTask(handle.db, { ...openTask, priority: '  ' })).rejects.toThrow(/tasks_priority|23514/);
    const missingCreatedAt = sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, updated_at)
      VALUES (
        ${openTask.id}::uuid,
        ${projectId}::uuid,
        ${openTask.number},
        ${openTask.title},
        ${openTask.status},
        ${openTask.priority},
        ${userId}::uuid,
        ${openTask.updatedAt}::timestamptz
      )
    `.execute(handle.db);
    await expect(missingCreatedAt).rejects.toThrow(/created_at|23502/);
    const missingUpdatedAt = sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at)
      VALUES (
        ${openTask.id}::uuid,
        ${projectId}::uuid,
        ${openTask.number},
        ${openTask.title},
        ${openTask.status},
        ${openTask.priority},
        ${userId}::uuid,
        ${openTask.createdAt}::timestamptz
      )
    `.execute(handle.db);
    await expect(missingUpdatedAt).rejects.toThrow(/updated_at|23502/);
    await insertTask(handle.db, defineTask(openTask));
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM tasks`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });
});
