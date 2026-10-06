import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import type { Api, InlineKeyboard } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_DAYS } from '../src/config/constants.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { projectCalendarDate, projectDaysBetween } from '../src/domain/shared/project-time.ts';
import {
  askAfterCanvas,
  blockerDetectedKey,
  decideStaleBlock,
  lastBlockerQuestionAt,
  uncheckedSince,
} from '../src/domain/tasks/detect-blocker.ts';
import { GITHUB_FACT_TYPES } from '../src/domain/tasks/github-origin.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
  blockedByListSilence,
} from '../src/domain/tasks/status.ts';
import { taskCanvasDay } from '../src/domain/tasks/task-day.ts';
import { TASK_TRANSITION_STALE, transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES, emit } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { detectStaleTasks, type DetectedBlocker } from '../src/infrastructure/detect-blocker.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import {
  readBlockersMigration,
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createScheduler } from '../src/infrastructure/scheduler.ts';
import { blockerQuestionText, noBlockerButton } from '../src/projections/blocker-question.ts';
import { sendBlockerQuestion } from '../src/telegram/blocker-question.ts';
import { silentLogger } from './log-lines.ts';

const userId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const moscowId = '00000000-0000-4000-8000-000000000010';
const utcId = '00000000-0000-4000-8000-000000000011';
const chatId = '00000000-0000-4000-8000-000000000020';
const memberId = '00000000-0000-4000-8000-000000000030';
const utcMemberId = '00000000-0000-4000-8000-000000000031';
const quietMemberId = '00000000-0000-4000-8000-000000000032';
const staleId = '00000000-0000-4000-8000-0000000000b1';
const freshId = '00000000-0000-4000-8000-0000000000b2';
const plannedId = '00000000-0000-4000-8000-0000000000b3';
const reviewId = '00000000-0000-4000-8000-0000000000b4';
const utcTaskId = '00000000-0000-4000-8000-0000000000b5';
const quietTaskId = '00000000-0000-4000-8000-0000000000b6';
const uncheckedId = '00000000-0000-4000-8000-0000000000b7';

const created = new Date('2026-09-27T20:00:00.000Z');
const freshAt = new Date('2026-09-28T20:00:00.000Z');
const now = new Date('2026-09-28T22:00:00.000Z');
const uncheckedAt = new Date('2026-09-28T21:00:00.000Z');
const nextDay = new Date('2026-09-29T22:00:00.000Z');
const twoDaysLater = new Date('2026-09-30T22:00:00.000Z');
const topic = 42;
const telegramChatId = '-1001234567890';

interface Hit {
  detected: DetectedBlocker;
  text: string;
  button: { label: string; callbackData: string };
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
  await pglite.exec(readBlockersMigration());
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
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
      (${otherId}::uuid, 1002, 'Борис', false)
  `.execute(db);
  await sql`
    INSERT INTO chats (id, telegram_chat_id, timezone)
    VALUES (${chatId}::uuid, ${telegramChatId}::bigint, 'Europe/Moscow')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES
      (${moscowId}::uuid, 'Альфа', '', 'Europe/Moscow', ${chatId}::uuid, ${created.toISOString()}::timestamptz),
      (${utcId}::uuid, 'Бета', '', 'Etc/UTC', ${chatId}::uuid, ${created.toISOString()}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES
      (${memberId}::uuid, ${moscowId}::uuid, ${userId}::uuid, 'member', ${topic}),
      (${utcMemberId}::uuid, ${utcId}::uuid, ${userId}::uuid, 'member', ${topic}),
      (${quietMemberId}::uuid, ${moscowId}::uuid, ${otherId}::uuid, 'member', NULL)
  `.execute(db);
  const at = created.toISOString();
  const fresh = freshAt.toISOString();
  await sql`
    INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
    VALUES
      (${staleId}::uuid, ${moscowId}::uuid, 7, 'Ждёт', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${freshId}::uuid, ${moscowId}::uuid, 8, 'Свежая', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${userId}::uuid, ${fresh}::timestamptz, ${fresh}::timestamptz),
      (${plannedId}::uuid, ${moscowId}::uuid, 9, 'План', ${TASK_STATUS_PLANNED}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${reviewId}::uuid, ${moscowId}::uuid, 10, 'На проверке', ${TASK_STATUS_REVIEW}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${utcTaskId}::uuid, ${utcId}::uuid, 7, 'UTC', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${quietTaskId}::uuid, ${moscowId}::uuid, 11, 'Без топика', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${otherId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${uncheckedId}::uuid, ${moscowId}::uuid, 12, 'Сняли галочку', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${userId}::uuid, ${at}::timestamptz, ${at}::timestamptz)
  `.execute(db);
  await emit(createEventJournal(db, silentLogger), {
    type: EVENT_TYPES.TASK_UNCHECKED,
    source: 'telegram',
    idempotencyKey: 'uncheck-recent',
    payload: { task_id: uncheckedId },
    actor: { id: userId, role: 'assignee' },
    subject: { entity: 'Task', id: uncheckedId },
    occurredAt: uncheckedAt,
    causationId: null,
    correlationId: null,
  });
}

async function statuses(db: Kysely<Database>): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; status: string }>`SELECT id::text AS id, status FROM tasks`.execute(db);
  return new Map(rows.rows.map((row) => [row.id, row.status]));
}

async function questions(db: Kysely<Database>): Promise<{ key: string; taskId: string; day: number; blockerId: string }[]> {
  const rows = await sql<{ idempotency_key: string; payload: unknown }>`
    SELECT idempotency_key, payload
    FROM events
    WHERE event_type = ${EVENT_TYPES.BLOCKER_DETECTED}
    ORDER BY created_at, idempotency_key
  `.execute(db);
  return rows.rows.map((row) => {
    const payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as { task_id: string; day: number; blocker_id: string }) : (row.payload as { task_id: string; day: number; blocker_id: string });
    return { key: row.idempotency_key, taskId: payload.task_id, day: payload.day, blockerId: payload.blocker_id };
  });
}

async function openBlockers(db: Kysely<Database>, taskId: string): Promise<number> {
  const rows = await sql<{ n: number | string }>`
    SELECT count(*) AS n FROM blockers WHERE task_id = ${taskId}::uuid AND resolved_at IS NULL AND reason IS NULL
  `.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}

async function run(db: Kysely<Database>, at: Date): Promise<Hit[]> {
  const hits: Hit[] = [];
  const api: Pick<Api, 'sendMessage'> = {
    async sendMessage(chatId, text, extra) {
      const keyboard = extra?.reply_markup as InlineKeyboard | undefined;
      const row = keyboard?.inline_keyboard[0]?.[0];
      const callbackData = row !== undefined && 'callback_data' in row ? row.callback_data : '';
      hits.push({
        detected: {
          projectId: '',
          projectName: '',
          assigneeId: '',
          taskId: '',
          blockerId: '',
          eventId: '',
          telegramChatId: String(chatId),
          topicId: extra?.message_thread_id ?? 0,
          taskNumber: 0,
          day: 0,
        },
        text,
        button: { label: row?.text ?? '', callbackData },
      });
      return { message_id: 1, date: 0, chat: { id: 0, type: 'supergroup' } } as Awaited<ReturnType<Api['sendMessage']>>;
    },
  };
  await detectStaleTasks(db, silentLogger, at, async (hit) => {
    await sendBlockerQuestion(api, {
      chatId: hit.telegramChatId,
      messageThreadId: hit.topicId,
      taskNumber: hit.taskNumber,
      day: hit.day,
      projectName: hit.projectName,
    });
    const sent = hits[hits.length - 1];
    if (sent !== undefined) sent.detected = hit;
  });
  return hits;
}

describe('застой задачи', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-05 в BLOCKED из IN_PROGRESS ведёт только акт застоя; GitHub и прочие статусы — нет', () => {
    const move = transitionTask(TASK_STATUS_IN_PROGRESS, TASK_TRANSITION_STALE);
    expect(move).toEqual({ from: TASK_STATUS_IN_PROGRESS, to: TASK_STATUS_BLOCKED, closesBlocker: false });
    expect(TASK_STATUSES.filter((status) => status === TASK_STATUS_IN_PROGRESS)).toHaveLength(1);
    for (const status of TASK_STATUSES) {
      if (status === TASK_STATUS_IN_PROGRESS) continue;
      expect(() => transitionTask(status, TASK_TRANSITION_STALE)).toThrowError(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
      );
    }
    for (const type of GITHUB_FACT_TYPES) {
      expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, type)).toThrow(DomainError);
      expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, type)).toThrow(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
      );
    }
    expect(move.to).not.toBe(TASK_STATUS_DONE);
    expect(move.to).not.toBe(TASK_STATUS_PLANNED);
    expect(move.to).not.toBe(TASK_STATUS_REVIEW);
  });

  it('INV-10 застой только у IN_PROGRESS без галочки дольше STALE_DAYS; вопрос не чаще того же порога', () => {
    expect(STALE_DAYS).toBe(projectDaysBetween(created, now, 'Europe/Moscow'));
    expect(projectDaysBetween(created, now, 'Etc/UTC')).toBe(STALE_DAYS - 1);
    expect(blockedByListSilence(created, now, 'Europe/Moscow')).toBe(true);
    expect(blockedByListSilence(created, now, 'Etc/UTC')).toBe(false);
    expect(blockedByListSilence(freshAt, now, 'Europe/Moscow')).toBe(false);

    const marks = [{ type: EVENT_TYPES.TASK_UNCHECKED, occurredAt: uncheckedAt }];
    expect(uncheckedSince(marks, created)?.toISOString()).toBe(uncheckedAt.toISOString());
    expect(decideStaleBlock({
      status: TASK_STATUS_IN_PROGRESS,
      taskId: uncheckedId,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks,
      now,
    })).toBeNull();
    expect(decideStaleBlock({
      status: TASK_STATUS_PLANNED,
      taskId: plannedId,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: [],
      now,
    })).toBeNull();
    expect(decideStaleBlock({
      status: TASK_STATUS_REVIEW,
      taskId: reviewId,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: [],
      now,
    })).toBeNull();

    const asked = [{ type: EVENT_TYPES.BLOCKER_DETECTED, occurredAt: now }];
    expect(lastBlockerQuestionAt(asked)?.toISOString()).toBe(now.toISOString());
    expect(decideStaleBlock({
      status: TASK_STATUS_IN_PROGRESS,
      taskId: staleId,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: asked,
      now: nextDay,
    })).toBeNull();
    const again = decideStaleBlock({
      status: TASK_STATUS_IN_PROGRESS,
      taskId: staleId,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: asked,
      now: twoDaysLater,
    });
    expect(again?.idempotencyKey).toBe(blockerDetectedKey(staleId, projectCalendarDate(twoDaysLater, 'Europe/Moscow')));
    expect(again?.day).toBe(taskCanvasDay(projectCalendarDate(created, 'Europe/Moscow'), projectCalendarDate(twoDaysLater, 'Europe/Moscow')));
  });

  it('INV-10 R-1017 R-1018 вопрос уходит после канваса суток и остаётся последним', async () => {
    const sent: string[] = [];
    await askAfterCanvas(
      async () => {
        sent.push('canvas');
      },
      async () => {
        sent.push('question');
      },
    );
    expect(sent).toEqual(['canvas', 'question']);
  });

  it('R-254 «7 не двигается 3-й день, что мешает?»', () => {
    const day = taskCanvasDay(projectCalendarDate(created, 'Europe/Moscow'), projectCalendarDate(now, 'Europe/Moscow'));
    expect(day).toBe(STALE_DAYS + 1);
    expect(blockerQuestionText(7, day)).toBe('задача 7 не двигается 3-й день, что мешает?');
  });

  it('R-255 с кнопкой «нет блокера»', () => {
    expect(noBlockerButton(7)).toEqual({ label: 'нет блокера', callbackData: 'task:noblock:7' });
  });

  it('INV-10 IN_PROGRESS без галочки два дня становится BLOCKED, PLANNED и REVIEW — нет', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const hits = await run(handle.db, now);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe('Альфа: задача 7 не двигается 3-й день, что мешает?');
    expect(hits[0]?.button).toEqual({ label: 'нет блокера', callbackData: 'task:noblock:7' });
    expect(hits[0]?.detected.telegramChatId).toBe(telegramChatId);
    expect(hits[0]?.detected.topicId).toBe(topic);
    expect(hits[0]?.detected.day).toBe(STALE_DAYS + 1);
    const status = await statuses(handle.db);
    expect(status.get(staleId)).toBe(TASK_STATUS_BLOCKED);
    expect(status.get(freshId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(status.get(plannedId)).toBe(TASK_STATUS_PLANNED);
    expect(status.get(reviewId)).toBe(TASK_STATUS_REVIEW);
    expect(status.get(utcTaskId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(status.get(quietTaskId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(status.get(uncheckedId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(await openBlockers(handle.db, staleId)).toBe(1);
    const asked = await questions(handle.db);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      key: blockerDetectedKey(staleId, projectCalendarDate(now, 'Europe/Moscow')),
      taskId: staleId,
      day: STALE_DAYS + 1,
    });
    expect(asked[0]?.blockerId.length).toBeGreaterThan(0);
  });

  it('INV-22 повтор хода не пишет второе событие и не спрашивает снова', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const clock: Clock = { now: () => now };
    const scheduler = createScheduler(clock);
    const seen: number[] = [];
    scheduler.register('A-28', async (at) => {
      const hits = await run(handle.db, at);
      seen.push(hits.length);
    });
    await scheduler.run();
    await scheduler.run();
    expect(seen).toEqual([1, 0]);
    expect(await questions(handle.db)).toHaveLength(1);
    expect(await openBlockers(handle.db, staleId)).toBe(1);
    expect((await statuses(handle.db)).get(staleId)).toBe(TASK_STATUS_BLOCKED);
  });

  it('INV-10 по одной задаче вопрос не чаще раза в STALE_DAYS; порог тот же, что у галочки', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    expect((await run(handle.db, now)).map((hit) => hit.detected.taskId)).toEqual([staleId]);
    await sql`UPDATE tasks SET status = ${TASK_STATUS_IN_PROGRESS} WHERE id = ${staleId}::uuid`.execute(handle.db);
    const soon = await run(handle.db, nextDay);
    expect(soon.map((hit) => hit.detected.taskId)).not.toContain(staleId);
    expect((await statuses(handle.db)).get(staleId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect((await questions(handle.db)).filter((row) => row.taskId === staleId)).toHaveLength(1);
    const again = await run(handle.db, twoDaysLater);
    expect(again.map((hit) => hit.detected.taskId)).toContain(staleId);
    expect(again.find((hit) => hit.detected.taskId === staleId)?.detected.taskNumber).toBe(7);
    expect(projectDaysBetween(now, twoDaysLater, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(projectDaysBetween(now, nextDay, 'Europe/Moscow')).toBe(STALE_DAYS - 1);
    expect((await statuses(handle.db)).get(staleId)).toBe(TASK_STATUS_BLOCKED);
    expect((await questions(handle.db)).filter((row) => row.taskId === staleId)).toHaveLength(2);
    expect(await openBlockers(handle.db, staleId)).toBe(2);
  });
});
