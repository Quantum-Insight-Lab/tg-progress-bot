import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCanvas, sameCanvasMessage, type Canvas } from '../src/domain/tasks/canvas.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readCanvasesMigration,
  readEventsMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';
const otherUserId = '00000000-0000-4000-8000-000000000002';

const today: Canvas = {
  id: '00000000-0000-4000-8000-0000000000c1',
  projectId,
  assigneeId: userId,
  topicId: 42,
  messageId: 900,
  canvasDate: '2026-09-28',
};

const otherDay: Canvas = {
  id: '00000000-0000-4000-8000-0000000000c2',
  projectId,
  assigneeId: userId,
  topicId: 42,
  messageId: 901,
  canvasDate: '2026-09-29',
};

async function openCanvases(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readCanvasesMigration());
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

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'canvases'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('E-7 канвас — таблица canvases', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-7 поля канваса: id, проект, исполнитель, топик, сообщение и дата', async () => {
    const canvas = defineCanvas(today);
    expect(canvas).toEqual(today);
    expect(defineCanvas({ ...today, canvasDate: ' 2026-09-28 ' }).canvasDate).toBe(today.canvasDate);

    const handle = await openCanvases();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'assignee_id',
      'canvas_date',
      'id',
      'message_id',
      'project_id',
      'topic_id',
    ]);
    await seed(handle.db);
    await insertCanvas(handle.db, canvas);
    await insertCanvas(handle.db, defineCanvas(otherDay));
    const rows = await sql<{
      id: string;
      project_id: string;
      assignee_id: string;
      topic_id: string;
      message_id: string;
      canvas_date: string;
    }>`
      SELECT
        id::text AS id,
        project_id::text AS project_id,
        assignee_id::text AS assignee_id,
        topic_id::text AS topic_id,
        message_id::text AS message_id,
        canvas_date::text AS canvas_date
      FROM canvases
      ORDER BY canvas_date
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        id: today.id,
        project_id: projectId,
        assignee_id: userId,
        topic_id: '42',
        message_id: '900',
        canvas_date: today.canvasDate,
      },
      {
        id: otherDay.id,
        project_id: projectId,
        assignee_id: userId,
        topic_id: '42',
        message_id: '901',
        canvas_date: otherDay.canvasDate,
      },
    ]);
  });

  it('E-7 ключ — id; проект, исполнитель, топик, сообщение и дата обязательны', async () => {
    expect(() => defineCanvas({ ...today, id: ' ' })).toThrow(DomainError);
    expect(() => defineCanvas({ ...today, id: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ID_BLANK }));
    expect(() => defineCanvas({ ...today, projectId: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_PROJECT_BLANK }),
    );
    expect(() => defineCanvas({ ...today, assigneeId: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_ASSIGNEE_BLANK }),
    );
    expect(() => defineCanvas({ ...today, topicId: 0 })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_TOPIC_ID }));
    expect(() => defineCanvas({ ...today, topicId: -1 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_TOPIC_ID }),
    );
    expect(() => defineCanvas({ ...today, messageId: 0 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_MESSAGE_ID }),
    );
    expect(() => defineCanvas({ ...today, messageId: 1.5 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_MESSAGE_ID }),
    );
    expect(() => defineCanvas({ ...today, canvasDate: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_DATE }));
    expect(() => defineCanvas({ ...today, canvasDate: '2026-9-28' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.CANVAS_DATE }),
    );

    const handle = await openCanvases();
    opened.push(handle);
    await seed(handle.db);
    await insertCanvas(handle.db, defineCanvas(today));
    await expect(insertCanvas(handle.db, defineCanvas({ ...otherDay, id: today.id }))).rejects.toThrow(
      /duplicate key|23505|canvases_pkey/,
    );

    const missingProject = sql`
      INSERT INTO canvases (id, assignee_id, topic_id, message_id, canvas_date)
      VALUES (
        ${otherDay.id}::uuid,
        ${userId}::uuid,
        42,
        901,
        ${otherDay.canvasDate}::date
      )
    `.execute(handle.db);
    await expect(missingProject).rejects.toThrow(/project_id|23502/);

    const unknownProject = insertCanvas(handle.db, {
      ...otherDay,
      projectId: '00000000-0000-4000-8000-000000000099',
    });
    await expect(unknownProject).rejects.toThrow(/canvases_project_id_fkey|23503/);

    const unknownAssignee = insertCanvas(handle.db, {
      ...otherDay,
      assigneeId: '00000000-0000-4000-8000-000000000098',
    });
    await expect(unknownAssignee).rejects.toThrow(/canvases_assignee_id_fkey|23503/);

    await expect(insertCanvas(handle.db, { ...otherDay, topicId: 0 })).rejects.toThrow(/canvases_topic_id_positive|23514/);
    await expect(insertCanvas(handle.db, { ...otherDay, messageId: -1 })).rejects.toThrow(
      /canvases_message_id_positive|23514/,
    );
    const missingDate = sql`
      INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id)
      VALUES (${otherDay.id}::uuid, ${projectId}::uuid, ${userId}::uuid, 42, 901)
    `.execute(handle.db);
    await expect(missingDate).rejects.toThrow(/canvas_date|23502/);
    const impossibleDate = sql`
      INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
      VALUES (
        ${otherDay.id}::uuid,
        ${projectId}::uuid,
        ${userId}::uuid,
        42,
        901,
        '2026-02-31'::date
      )
    `.execute(handle.db);
    await expect(impossibleDate).rejects.toThrow(/date|22008|invalid/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM canvases`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });
});

describe('INV-23 одно сообщение на проект, исполнителя и дату', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-23 пара «проект + исполнитель + дата» — не больше одного сообщения; у другого исполнителя канвас свой', async () => {
    const secondMessage: Canvas = { ...today, id: otherDay.id, messageId: 901 };
    expect(sameCanvasMessage(today, secondMessage)).toBe(true);
    expect(sameCanvasMessage(today, otherDay)).toBe(false);
    expect(sameCanvasMessage(today, { ...today, assigneeId: otherUserId })).toBe(false);
    expect(sameCanvasMessage(today, { ...today, projectId: otherProjectId })).toBe(false);

    const handle = await openCanvases();
    opened.push(handle);
    await seed(handle.db);
    await insertCanvas(handle.db, defineCanvas(today));
    await expect(insertCanvas(handle.db, defineCanvas(secondMessage))).rejects.toThrow(
      /canvases_project_assignee_date_unique|duplicate key|23505/,
    );
    await insertCanvas(handle.db, defineCanvas(otherDay));
    await insertCanvas(handle.db, defineCanvas({ ...today, id: '00000000-0000-4000-8000-0000000000c3', assigneeId: otherUserId, messageId: 902 }));
    await insertCanvas(
      handle.db,
      defineCanvas({ ...today, id: '00000000-0000-4000-8000-0000000000c4', projectId: otherProjectId, messageId: 903 }),
    );

    const rows = await sql<{ project_id: string; assignee_id: string; canvas_date: string; message_id: string }>`
      SELECT
        project_id::text AS project_id,
        assignee_id::text AS assignee_id,
        canvas_date::text AS canvas_date,
        message_id::text AS message_id
      FROM canvases
      ORDER BY message_id
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { project_id: projectId, assignee_id: userId, canvas_date: today.canvasDate, message_id: '900' },
      { project_id: projectId, assignee_id: userId, canvas_date: otherDay.canvasDate, message_id: '901' },
      { project_id: projectId, assignee_id: otherUserId, canvas_date: today.canvasDate, message_id: '902' },
      { project_id: otherProjectId, assignee_id: userId, canvas_date: today.canvasDate, message_id: '903' },
    ]);
  });
});
