import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCanvas, type Canvas } from '../src/domain/tasks/canvas.ts';
import { ABSENT_CANVAS_ITEM_BUTTONS, byCanvasPosition, defineCanvasItem, type CanvasItem } from '../src/domain/tasks/canvas-item.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_IN_PROGRESS, TASK_STATUS_REVIEW } from '../src/domain/tasks/status.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readCanvasItemsMigration,
  readCanvasesMigration,
  readEventsMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';
const at = '2026-09-28T07:33:00.000Z';

const today: Canvas = {
  id: '00000000-0000-4000-8000-0000000000c1',
  projectId,
  assigneeId: userId,
  topicId: 42,
  messageId: 900,
  canvasDate: '2026-09-28',
};

const yesterday: Canvas = {
  id: '00000000-0000-4000-8000-0000000000c2',
  projectId,
  assigneeId: userId,
  topicId: 42,
  messageId: 901,
  canvasDate: '2026-09-27',
};

const firstTaskId = '00000000-0000-4000-8000-0000000000b1';
const secondTaskId = '00000000-0000-4000-8000-0000000000b2';

const later: CanvasItem = {
  id: '00000000-0000-4000-8000-0000000000d1',
  canvasId: today.id,
  taskId: firstTaskId,
  position: 2,
  carriedFromCanvasId: yesterday.id,
};

const earlier: CanvasItem = {
  id: '00000000-0000-4000-8000-0000000000d2',
  canvasId: today.id,
  taskId: secondTaskId,
  position: 1,
  carriedFromCanvasId: null,
};

async function openItems(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
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

async function seed(db: Kysely<Database>): Promise<void> {
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
      (${firstTaskId}::uuid, ${projectId}::uuid, 7, 'Первая', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${secondTaskId}::uuid, ${projectId}::uuid, 8, 'Вторая', ${TASK_STATUS_REVIEW}, 'high', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz)
  `.execute(db);
  await insertCanvas(db, defineCanvas(yesterday));
  await insertCanvas(db, defineCanvas(today));
}

async function insertCanvas(db: Kysely<Database>, canvas: Canvas): Promise<void> {
  await sql`
    INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
    VALUES (
      ${canvas.id}::uuid,
      ${canvas.projectId}::uuid,
      ${canvas.assigneeId}::uuid,
      ${canvas.topicId},
      ${canvas.messageId},
      ${canvas.canvasDate}::date
    )
  `.execute(db);
}

async function insertItem(db: Kysely<Database>, item: CanvasItem): Promise<void> {
  await sql`
    INSERT INTO canvas_items (id, canvas_id, task_id, position, carried_from_canvas_id)
    VALUES (
      ${item.id}::uuid,
      ${item.canvasId}::uuid,
      ${item.taskId}::uuid,
      ${item.position},
      ${item.carriedFromCanvasId}::uuid
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'canvas_items'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('E-8 пункт канваса — таблица canvas_items', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-8 поля пункта: id, канвас, задача, место и канвас переноса', async () => {
    const item = defineCanvasItem(later);
    expect(item).toEqual(later);
    expect(defineCanvasItem(earlier).carriedFromCanvasId).toBeNull();

    const handle = await openItems();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'canvas_id',
      'carried_from_canvas_id',
      'id',
      'position',
      'task_id',
    ]);
    await seed(handle.db);
    await insertItem(handle.db, item);
    await insertItem(handle.db, defineCanvasItem(earlier));
    const rows = await sql<{
      id: string;
      canvas_id: string;
      task_id: string;
      position: number;
      carried_from_canvas_id: string | null;
    }>`
      SELECT
        id::text AS id,
        canvas_id::text AS canvas_id,
        task_id::text AS task_id,
        position,
        carried_from_canvas_id::text AS carried_from_canvas_id
      FROM canvas_items
      ORDER BY position
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        id: earlier.id,
        canvas_id: today.id,
        task_id: secondTaskId,
        position: 1,
        carried_from_canvas_id: null,
      },
      {
        id: later.id,
        canvas_id: today.id,
        task_id: firstTaskId,
        position: 2,
        carried_from_canvas_id: yesterday.id,
      },
    ]);
  });

  it('E-8 ключ — id; канвас, задача и место обязательны и ссылаются на свои строки', async () => {
    expect(() => defineCanvasItem({ ...later, id: ' ' })).toThrow(DomainError);
    expect(() => defineCanvasItem({ ...later, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_ID_BLANK }),
    );
    expect(() => defineCanvasItem({ ...later, canvasId: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_CANVAS_BLANK }),
    );
    expect(() => defineCanvasItem({ ...later, taskId: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_TASK_BLANK }),
    );
    expect(() => defineCanvasItem({ ...later, position: 1.5 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_POSITION }),
    );
    expect(() => defineCanvasItem({ ...later, carriedFromCanvasId: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_CARRIED_BLANK }),
    );

    const handle = await openItems();
    opened.push(handle);
    await seed(handle.db);
    await insertItem(handle.db, defineCanvasItem(later));
    await expect(insertItem(handle.db, defineCanvasItem({ ...earlier, id: later.id }))).rejects.toThrow(
      /duplicate key|23505|canvas_items_pkey/,
    );

    const missingCanvas = sql`
      INSERT INTO canvas_items (id, task_id, position)
      VALUES (${earlier.id}::uuid, ${secondTaskId}::uuid, 1)
    `.execute(handle.db);
    await expect(missingCanvas).rejects.toThrow(/canvas_id|23502/);

    const missingTask = sql`
      INSERT INTO canvas_items (id, canvas_id, position)
      VALUES (${earlier.id}::uuid, ${today.id}::uuid, 1)
    `.execute(handle.db);
    await expect(missingTask).rejects.toThrow(/task_id|23502/);

    const missingPosition = sql`
      INSERT INTO canvas_items (id, canvas_id, task_id)
      VALUES (${earlier.id}::uuid, ${today.id}::uuid, ${secondTaskId}::uuid)
    `.execute(handle.db);
    await expect(missingPosition).rejects.toThrow(/position|23502/);

    await expect(
      insertItem(handle.db, { ...earlier, canvasId: '00000000-0000-4000-8000-000000000099' }),
    ).rejects.toThrow(/canvas_items_canvas_id_fkey|23503/);
    await expect(
      insertItem(handle.db, { ...earlier, taskId: '00000000-0000-4000-8000-000000000098' }),
    ).rejects.toThrow(/canvas_items_task_id_fkey|23503/);
    await expect(
      insertItem(handle.db, { ...earlier, carriedFromCanvasId: '00000000-0000-4000-8000-000000000097' }),
    ).rejects.toThrow(/canvas_items_carried_from_canvas_id_fkey|23503/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM canvas_items`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('E-8 кнопки в таблицу не складываются: их рисуют из tasks.status', async () => {
    const stored = defineCanvasItem(later);
    expect(stored).not.toHaveProperty('buttons');
    expect(stored).not.toHaveProperty('button');
    expect(Object.keys(stored).sort()).toEqual(['canvasId', 'carriedFromCanvasId', 'id', 'position', 'taskId']);
    for (const field of ABSENT_CANVAS_ITEM_BUTTONS) {
      expect(stored).not.toHaveProperty(field);
      const withButton = { ...later, [field]: 'в план' };
      expect(() => defineCanvasItem(withButton)).toThrow(DomainError);
      expect(() => defineCanvasItem(withButton)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ITEM_BUTTONS }));
    }

    const handle = await openItems();
    opened.push(handle);
    await seed(handle.db);
    const columns = await columnNames(handle.db);
    for (const field of ABSENT_CANVAS_ITEM_BUTTONS) expect(columns).not.toContain(field);
    expect(columns).not.toContain('status');
    await insertItem(handle.db, stored);
    const before = await sql`
      SELECT id::text AS id, canvas_id::text AS canvas_id, task_id::text AS task_id, position, carried_from_canvas_id::text AS carried_from_canvas_id
      FROM canvas_items
    `.execute(handle.db);
    await sql`
      UPDATE tasks SET status = ${TASK_STATUS_REVIEW} WHERE id = ${firstTaskId}::uuid
    `.execute(handle.db);
    const after = await sql`
      SELECT id::text AS id, canvas_id::text AS canvas_id, task_id::text AS task_id, position, carried_from_canvas_id::text AS carried_from_canvas_id
      FROM canvas_items
    `.execute(handle.db);
    const status = await sql<{ status: string }>`
      SELECT status FROM tasks WHERE id = ${firstTaskId}::uuid
    `.execute(handle.db);
    expect(after.rows).toEqual(before.rows);
    expect(status.rows[0]?.status).toBe(TASK_STATUS_REVIEW);
  });
});

describe('L-9 пункт показывает задачу: состав канваса и порядок', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('L-9 одна задача на канвасе один раз, место уникально, перенос ссылается на канвас', async () => {
    const ordered = byCanvasPosition([defineCanvasItem(later), defineCanvasItem(earlier)]);
    expect(ordered.map((item) => item.taskId)).toEqual([secondTaskId, firstTaskId]);
    expect(ordered.map((item) => item.position)).toEqual([1, 2]);
    expect(ordered[1]?.carriedFromCanvasId).toBe(yesterday.id);

    const handle = await openItems();
    opened.push(handle);
    await seed(handle.db);
    await insertItem(handle.db, defineCanvasItem(later));
    await expect(insertItem(handle.db, defineCanvasItem({ ...earlier, taskId: firstTaskId, position: 3 }))).rejects.toThrow(
      /canvas_items_canvas_task_unique|duplicate key|23505/,
    );
    await expect(insertItem(handle.db, defineCanvasItem({ ...earlier, position: later.position }))).rejects.toThrow(
      /canvas_items_canvas_position_unique|duplicate key|23505/,
    );
    await insertItem(handle.db, defineCanvasItem(earlier));
    await insertItem(
      handle.db,
      defineCanvasItem({
        ...later,
        id: '00000000-0000-4000-8000-0000000000d3',
        canvasId: yesterday.id,
        position: later.position,
        carriedFromCanvasId: null,
      }),
    );

    const rows = await sql<{ canvas_id: string; task_id: string; position: number }>`
      SELECT canvas_id::text AS canvas_id, task_id::text AS task_id, position
      FROM canvas_items
      ORDER BY canvas_id, position
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { canvas_id: today.id, task_id: secondTaskId, position: 1 },
      { canvas_id: today.id, task_id: firstTaskId, position: 2 },
      { canvas_id: yesterday.id, task_id: firstTaskId, position: 2 },
    ]);
  });
});
