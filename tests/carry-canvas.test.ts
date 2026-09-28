import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { projectCalendarDate } from '../src/domain/shared/project-time.ts';
import type { Canvas } from '../src/domain/tasks/canvas.ts';
import {
  carryCanvasPair,
  carriedCanvasKey,
  tasksForCarry,
  type CarryTask,
} from '../src/domain/tasks/carry-canvas.ts';
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
  blockedByListSilence,
  orderPlan,
  standsInTasksBlock,
} from '../src/domain/tasks/status.ts';
import { taskCanvasDay } from '../src/domain/tasks/task-day.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { carryAssigneeDay, carryOpenCanvases } from '../src/infrastructure/carry-canvas.ts';
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
import { createScheduler } from '../src/infrastructure/scheduler.ts';
import { planFirstLine } from '../src/projections/plan-block.ts';
import { TASK_REVIEW_MARK, TASK_REVIEW_PLACE, taskFirstLine } from '../src/projections/tasks-block.ts';

const rootId = '00000000-0000-4000-8000-000000000001';
const anyaId = '00000000-0000-4000-8000-000000000002';
const veraId = '00000000-0000-4000-8000-000000000003';
const borisId = '00000000-0000-4000-8000-000000000004';
const moscowId = '00000000-0000-4000-8000-000000000010';
const honoluluId = '00000000-0000-4000-8000-000000000011';
const moscowYesterdayId = '00000000-0000-4000-8000-0000000000c1';
const moscowTodayId = '00000000-0000-4000-8000-0000000000c2';
const honoluluBeforeId = '00000000-0000-4000-8000-0000000000c3';
const honoluluTodayId = '00000000-0000-4000-8000-0000000000c4';
const honoluluFutureId = '00000000-0000-4000-8000-0000000000c5';
const blockedId = '00000000-0000-4000-8000-0000000000b1';
const progressId = '00000000-0000-4000-8000-0000000000b2';
const reviewId = '00000000-0000-4000-8000-0000000000b3';
const plannedHighId = '00000000-0000-4000-8000-0000000000b4';
const plannedLowId = '00000000-0000-4000-8000-0000000000b5';
const doneId = '00000000-0000-4000-8000-0000000000b6';
const cancelledId = '00000000-0000-4000-8000-0000000000b7';
const bornTodayId = '00000000-0000-4000-8000-0000000000b8';
const veraTaskId = '00000000-0000-4000-8000-0000000000b9';
const honoluluTaskId = '00000000-0000-4000-8000-0000000000ba';
const yesterdayItemId = '00000000-0000-4000-8000-0000000000d1';

const early = new Date('2026-09-28T20:30:00.000Z');
const later = new Date('2026-09-28T22:00:00.000Z');
const staleFrom = new Date('2026-09-27T20:00:00.000Z');

const moscowYesterday: Canvas = {
  id: moscowYesterdayId,
  projectId: moscowId,
  assigneeId: anyaId,
  topicId: 42,
  messageId: 11,
  canvasDate: '2026-09-28',
};

const moscowToday: Canvas = {
  id: moscowTodayId,
  projectId: moscowId,
  assigneeId: anyaId,
  topicId: 42,
  messageId: 12,
  canvasDate: '2026-09-29',
};

interface ItemRow {
  id: string;
  canvas_id: string;
  task_id: string;
  position: number;
  carried_from_canvas_id: string | null;
}

interface CanvasRow {
  id: string;
  message_id: string;
  canvas_date: string;
}

interface StatusRow {
  id: string;
  status: string;
}

interface CarryEvent {
  key: string;
  payload: { from_canvas_id: string; to_canvas_id: string; task_ids: string[] };
}

function carryTask(input: {
  id: string;
  assigneeId: string;
  number: number;
  status: CarryTask['status'];
  priority: CarryTask['priority'];
  createdOn: string;
  projectId?: string;
}): CarryTask {
  return {
    id: input.id,
    projectId: input.projectId ?? moscowId,
    assigneeId: input.assigneeId,
    number: input.number,
    status: input.status,
    priority: input.priority,
    createdAt: `${input.createdOn}T00:00:00.000Z`,
    createdOn: input.createdOn,
  };
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
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

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES
      (${rootId}::uuid, 1, 'Корень', true),
      (${anyaId}::uuid, 2, 'Аня', false),
      (${veraId}::uuid, 3, 'Вера', false),
      (${borisId}::uuid, 4, 'Борис', false)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES
      (${moscowId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, ${later.toISOString()}::timestamptz),
      (${honoluluId}::uuid, 'Бета', '', 'Pacific/Honolulu', NULL, ${later.toISOString()}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
    VALUES
      (${plannedHighId}::uuid, ${moscowId}::uuid, 1, 'высокий', ${TASK_STATUS_PLANNED}, ${TASK_PRIORITY_HIGH}, ${anyaId}::uuid, '2026-09-26T08:00:00.000Z'::timestamptz, '2026-09-26T08:00:00.000Z'::timestamptz, NULL),
      (${blockedId}::uuid, ${moscowId}::uuid, 3, 'блок', ${TASK_STATUS_BLOCKED}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, '2026-09-27T08:00:00.000Z'::timestamptz, '2026-09-27T08:00:00.000Z'::timestamptz, NULL),
      (${plannedLowId}::uuid, ${moscowId}::uuid, 4, 'низкий', ${TASK_STATUS_PLANNED}, ${TASK_PRIORITY_LOW}, ${anyaId}::uuid, '2026-09-27T11:00:00.000Z'::timestamptz, '2026-09-27T11:00:00.000Z'::timestamptz, NULL),
      (${doneId}::uuid, ${moscowId}::uuid, 5, 'готова', ${TASK_STATUS_DONE}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, '2026-09-27T08:00:00.000Z'::timestamptz, '2026-09-27T08:00:00.000Z'::timestamptz, '2026-09-27T12:00:00.000Z'::timestamptz),
      (${cancelledId}::uuid, ${moscowId}::uuid, 6, 'снята', ${TASK_STATUS_CANCELLED}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, '2026-09-27T08:00:00.000Z'::timestamptz, '2026-09-27T08:00:00.000Z'::timestamptz, NULL),
      (${progressId}::uuid, ${moscowId}::uuid, 7, 'в работе', ${TASK_STATUS_IN_PROGRESS}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, '2026-09-27T09:00:00.000Z'::timestamptz, '2026-09-27T09:00:00.000Z'::timestamptz, NULL),
      (${reviewId}::uuid, ${moscowId}::uuid, 9, 'на проверке', ${TASK_STATUS_REVIEW}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, '2026-09-27T10:00:00.000Z'::timestamptz, '2026-09-27T10:00:00.000Z'::timestamptz, NULL),
      (${bornTodayId}::uuid, ${moscowId}::uuid, 10, 'сегодняшняя', ${TASK_STATUS_IN_PROGRESS}, ${TASK_PRIORITY_NORMAL}, ${anyaId}::uuid, ${later.toISOString()}::timestamptz, ${later.toISOString()}::timestamptz, NULL),
      (${veraTaskId}::uuid, ${moscowId}::uuid, 2, 'чужая', ${TASK_STATUS_IN_PROGRESS}, ${TASK_PRIORITY_NORMAL}, ${veraId}::uuid, '2026-09-27T08:00:00.000Z'::timestamptz, '2026-09-27T08:00:00.000Z'::timestamptz, NULL),
      (${honoluluTaskId}::uuid, ${honoluluId}::uuid, 8, 'остров', ${TASK_STATUS_IN_PROGRESS}, ${TASK_PRIORITY_NORMAL}, ${borisId}::uuid, '2026-09-26T12:00:00.000Z'::timestamptz, '2026-09-26T12:00:00.000Z'::timestamptz, NULL)
  `.execute(db);
  await insertCanvas(db, moscowYesterday);
  await insertCanvas(db, moscowToday);
  await insertCanvas(db, {
    id: honoluluBeforeId,
    projectId: honoluluId,
    assigneeId: borisId,
    topicId: 7,
    messageId: 21,
    canvasDate: '2026-09-27',
  });
  await insertCanvas(db, {
    id: honoluluTodayId,
    projectId: honoluluId,
    assigneeId: borisId,
    topicId: 7,
    messageId: 22,
    canvasDate: '2026-09-28',
  });
  await insertCanvas(db, {
    id: honoluluFutureId,
    projectId: honoluluId,
    assigneeId: borisId,
    topicId: 7,
    messageId: 23,
    canvasDate: '2026-09-29',
  });
  await sql`
    INSERT INTO canvas_items (id, canvas_id, task_id, position, carried_from_canvas_id)
    VALUES (${yesterdayItemId}::uuid, ${moscowYesterdayId}::uuid, ${progressId}::uuid, 1, NULL)
  `.execute(db);
}

async function items(db: Kysely<Database>): Promise<ItemRow[]> {
  const result = await sql<ItemRow>`
    SELECT id::text AS id,
           canvas_id::text AS canvas_id,
           task_id::text AS task_id,
           position,
           carried_from_canvas_id::text AS carried_from_canvas_id
    FROM canvas_items
    ORDER BY canvas_id, position
  `.execute(db);
  return result.rows;
}

async function canvases(db: Kysely<Database>): Promise<CanvasRow[]> {
  const result = await sql<CanvasRow>`
    SELECT id::text AS id, message_id::text AS message_id, canvas_date::text AS canvas_date
    FROM canvases
    ORDER BY canvas_date, message_id
  `.execute(db);
  return result.rows;
}

async function statuses(db: Kysely<Database>): Promise<StatusRow[]> {
  const result = await sql<StatusRow>`
    SELECT id::text AS id, status FROM tasks ORDER BY number
  `.execute(db);
  return result.rows;
}

async function carryEvents(db: Kysely<Database>): Promise<CarryEvent[]> {
  const result = await sql<{ idempotency_key: string; payload: unknown }>`
    SELECT idempotency_key, payload
    FROM events
    WHERE event_type = ${EVENT_TYPES.CANVAS_CARRIED_OVER}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => {
    const payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as CarryEvent['payload']) : (row.payload as CarryEvent['payload']);
    return { key: row.idempotency_key, payload };
  });
}

describe('перенос дня на новый канвас', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-09 незакрытые переносятся тому же исполнителю, снятые и подтверждённые — нет', async () => {
    const sample = [
      carryTask({ id: blockedId, assigneeId: anyaId, number: 3, status: TASK_STATUS_BLOCKED, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
      carryTask({ id: progressId, assigneeId: anyaId, number: 7, status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
      carryTask({ id: reviewId, assigneeId: anyaId, number: 9, status: TASK_STATUS_REVIEW, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
      carryTask({ id: plannedHighId, assigneeId: anyaId, number: 1, status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, createdOn: '2026-09-26' }),
      carryTask({ id: plannedLowId, assigneeId: anyaId, number: 4, status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_LOW, createdOn: '2026-09-27' }),
      carryTask({ id: doneId, assigneeId: anyaId, number: 5, status: TASK_STATUS_DONE, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
      carryTask({ id: cancelledId, assigneeId: anyaId, number: 6, status: TASK_STATUS_CANCELLED, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
      carryTask({ id: bornTodayId, assigneeId: anyaId, number: 10, status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-29' }),
      carryTask({ id: veraTaskId, assigneeId: veraId, number: 2, status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_NORMAL, createdOn: '2026-09-27' }),
    ];
    const carried = tasksForCarry(moscowYesterday, moscowToday, sample);
    expect(carried.map((task) => task.id)).toEqual([blockedId, progressId, reviewId, plannedHighId, plannedLowId]);
    expect(carried.map((task) => task.status)).toEqual([
      TASK_STATUS_BLOCKED,
      TASK_STATUS_IN_PROGRESS,
      TASK_STATUS_REVIEW,
      TASK_STATUS_PLANNED,
      TASK_STATUS_PLANNED,
    ]);
    expect(standsInTasksBlock(TASK_STATUS_REVIEW)).toBe(true);
    expect(standsInTasksBlock(TASK_STATUS_PLANNED)).toBe(false);
    expect(orderPlan(carried).map((task) => task.id)).toEqual([plannedHighId, plannedLowId]);
    expect(tasksForCarry(moscowToday, moscowToday, sample)).toEqual([]);
    expect(tasksForCarry(moscowYesterday, { ...moscowToday, assigneeId: veraId }, sample)).toEqual([]);

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const beforeCanvases = await canvases(handle.db);
    const beforeStatuses = await statuses(handle.db);
    await carryAssigneeDay(handle.db, moscowId, anyaId, later);
    const moved = (await items(handle.db)).filter((item) => item.canvas_id === moscowTodayId);
    expect(moved.map((item) => item.task_id)).toEqual([blockedId, progressId, reviewId, plannedHighId, plannedLowId]);
    expect(moved.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(moved.every((item) => item.carried_from_canvas_id === moscowYesterdayId)).toBe(true);
    expect((await items(handle.db)).filter((item) => item.canvas_id === moscowYesterdayId)).toEqual([
      {
        id: yesterdayItemId,
        canvas_id: moscowYesterdayId,
        task_id: progressId,
        position: 1,
        carried_from_canvas_id: null,
      },
    ]);
    expect(await canvases(handle.db)).toEqual(beforeCanvases);
    expect(await statuses(handle.db)).toEqual(beforeStatuses);
    const review = taskFirstLine({
      number: 9,
      title: 'на проверке',
      status: TASK_STATUS_REVIEW,
      day: taskCanvasDay('2026-09-27', '2026-09-29'),
      priority: TASK_PRIORITY_NORMAL,
    });
    expect(review.startsWith(TASK_REVIEW_MARK)).toBe(true);
    expect(review).toContain(TASK_REVIEW_PLACE);
    const planned = planFirstLine({
      number: 1,
      title: 'высокий',
      status: TASK_STATUS_PLANNED,
      day: taskCanvasDay('2026-09-26', '2026-09-29'),
      priority: TASK_PRIORITY_HIGH,
    });
    expect(planned).toContain('высокий');
    expect(planned.includes(TASK_REVIEW_MARK)).toBe(false);
    expect(planned.includes('○')).toBe(false);
    const event = (await carryEvents(handle.db)).find((row) => row.payload.to_canvas_id === moscowTodayId);
    expect(event?.key).toBe(carriedCanvasKey(moscowId, anyaId, '2026-09-29'));
    expect(event?.payload).toEqual({
      from_canvas_id: moscowYesterdayId,
      to_canvas_id: moscowTodayId,
      task_ids: [blockedId, progressId, reviewId, plannedHighId, plannedLowId],
    });
    expect(event?.payload.task_ids.includes(veraTaskId)).toBe(false);
    expect(event?.payload.task_ids.includes(doneId)).toBe(false);
    expect(event?.payload.task_ids.includes(cancelledId)).toBe(false);
    expect(event?.payload.task_ids.includes(bornTodayId)).toBe(false);
  });

  it('INV-22 повтор переноса не пишет второе событие и не дублирует пункты', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const clock: Clock = { now: () => later };
    const scheduler = createScheduler(clock);
    scheduler.register('A-30', (now) => carryOpenCanvases(handle.db, now));
    await scheduler.run();
    const onceItems = await items(handle.db);
    const onceEvents = await carryEvents(handle.db);
    expect(onceEvents).toHaveLength(2);
    await scheduler.run();
    await carryOpenCanvases(handle.db, later);
    expect(await items(handle.db)).toEqual(onceItems);
    expect(await carryEvents(handle.db)).toEqual(onceEvents);
    expect(onceEvents.map((row) => row.key).sort()).toEqual(
      [carriedCanvasKey(moscowId, anyaId, '2026-09-29'), carriedCanvasKey(honoluluId, borisId, '2026-09-28')].sort(),
    );
  });

  it('INV-24 сегодня, граница суток и застой — по таймзоне проекта; канвас не переписывается', async () => {
    expect(projectCalendarDate(early, 'Europe/Moscow')).toBe('2026-09-28');
    expect(projectCalendarDate(later, 'Europe/Moscow')).toBe('2026-09-29');
    expect(projectCalendarDate(later, 'Pacific/Honolulu')).toBe('2026-09-28');
    expect(projectCalendarDate(later, 'Etc/UTC')).toBe('2026-09-28');
    expect(blockedByListSilence(staleFrom, later, 'Europe/Moscow')).toBe(true);
    expect(blockedByListSilence(staleFrom, later, 'Etc/UTC')).toBe(false);
    const pair = carryCanvasPair([moscowYesterday, moscowToday], '2026-09-28');
    expect(pair).toBeNull();
    expect(carryCanvasPair([moscowYesterday, moscowToday], '2026-09-29')).toEqual({
      from: moscowYesterday,
      to: moscowToday,
    });

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const sent = await canvases(handle.db);
    await carryOpenCanvases(handle.db, early);
    expect(await carryEvents(handle.db)).toEqual([
      {
        key: carriedCanvasKey(honoluluId, borisId, '2026-09-28'),
        payload: {
          from_canvas_id: honoluluBeforeId,
          to_canvas_id: honoluluTodayId,
          task_ids: [honoluluTaskId],
        },
      },
    ]);
    expect((await items(handle.db)).some((item) => item.canvas_id === moscowTodayId)).toBe(false);
    expect((await items(handle.db)).some((item) => item.canvas_id === honoluluFutureId)).toBe(false);

    await carryOpenCanvases(handle.db, later);
    const moscow = (await carryEvents(handle.db)).find((row) => row.payload.to_canvas_id === moscowTodayId);
    expect(moscow?.payload.task_ids).toEqual([blockedId, progressId, reviewId, plannedHighId, plannedLowId]);
    expect(await canvases(handle.db)).toEqual(sent);
    expect((await items(handle.db)).filter((item) => item.canvas_id === honoluluFutureId)).toEqual([]);

    await sql`UPDATE projects SET timezone = 'Etc/UTC' WHERE id = ${moscowId}::uuid`.execute(handle.db);
    await carryOpenCanvases(handle.db, later);
    expect(await canvases(handle.db)).toEqual(sent);
    expect((await items(handle.db)).filter((item) => item.canvas_id === moscowYesterdayId)).toEqual([
      {
        id: yesterdayItemId,
        canvas_id: moscowYesterdayId,
        task_id: progressId,
        position: 1,
        carried_from_canvas_id: null,
      },
    ]);
    expect(await carryEvents(handle.db)).toHaveLength(2);
    expect(projectCalendarDate(later, 'Etc/UTC')).not.toBe('2026-09-29');
  });
});
