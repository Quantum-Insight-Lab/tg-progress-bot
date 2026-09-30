import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import type { Api } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_DAYS } from '../src/config/constants.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { projectCalendarDate, projectDaysBetween } from '../src/domain/shared/project-time.ts';
import { withBlockerReason } from '../src/domain/tasks/blocker.ts';
import { questionReplyForTask } from '../src/domain/tasks/blocker-answer.ts';
import { GITHUB_FACT_TYPES } from '../src/domain/tasks/github-origin.ts';
import {
  decideReviewReminder,
  lastReviewReminderAt,
  reviewRemindedKey,
  reviewWaitingSince,
} from '../src/domain/tasks/remind-review.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
} from '../src/domain/tasks/status.ts';
import { TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { TASK_TRANSITION_NO_BLOCKER, transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES, emit } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createBlockerAnswerActions } from '../src/infrastructure/tasks.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { remindStaleReviews, type RemindedReview } from '../src/infrastructure/remind-review.ts';
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
import { blockerQuestionReply, blockerQuestionText, parseNoBlockerData } from '../src/projections/blocker-question.ts';
import { reviewReminderText } from '../src/projections/review-reminder.ts';
import { replyToBlockerReason, replyToNoBlocker } from '../src/telegram/blocker-answer.ts';
import { sendReviewReminder } from '../src/telegram/review-reminder.ts';
import { silentLogger } from './log-lines.ts';

const leadId = '00000000-0000-4000-8000-000000000001';
const assigneeId = '00000000-0000-4000-8000-000000000002';
const secondLeadId = '00000000-0000-4000-8000-000000000003';
const projectId = '00000000-0000-4000-8000-000000000010';
const chatId = '00000000-0000-4000-8000-000000000020';
const leadMemberId = '00000000-0000-4000-8000-000000000030';
const assigneeMemberId = '00000000-0000-4000-8000-000000000031';
const secondLeadMemberId = '00000000-0000-4000-8000-000000000032';
const blockedId = '00000000-0000-4000-8000-0000000000b1';
const reviewId = '00000000-0000-4000-8000-0000000000b2';
const freshReviewId = '00000000-0000-4000-8000-0000000000b3';
const progressId = '00000000-0000-4000-8000-0000000000b4';
const plannedId = '00000000-0000-4000-8000-0000000000b5';
const quietReviewId = '00000000-0000-4000-8000-0000000000b6';
const blockerId = '00000000-0000-4000-8000-0000000000c1';

const created = new Date('2026-09-27T20:00:00.000Z');
const now = new Date('2026-09-28T22:00:00.000Z');
const nextDay = new Date('2026-09-29T22:00:00.000Z');
const twoDaysLater = new Date('2026-09-30T22:00:00.000Z');
const topic = 42;
const telegramChatId = '-1001234567890';
const questionDay = 3;

const assignee = { id: 1002, is_bot: false };
const place = { type: TASK_TOPIC_CHAT, id: telegramChatId, topicId: topic };

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
      (${leadId}::uuid, 1001, 'Аня', true),
      (${assigneeId}::uuid, 1002, 'Борис', false),
      (${secondLeadId}::uuid, 1003, 'Вера', false)
  `.execute(db);
  await sql`
    INSERT INTO chats (id, telegram_chat_id, timezone)
    VALUES (${chatId}::uuid, ${telegramChatId}::bigint, 'Europe/Moscow')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', ${chatId}::uuid, ${created.toISOString()}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES
      (${leadMemberId}::uuid, ${projectId}::uuid, ${leadId}::uuid, 'lead', NULL),
      (${assigneeMemberId}::uuid, ${projectId}::uuid, ${assigneeId}::uuid, 'member', ${topic}),
      (${secondLeadMemberId}::uuid, ${projectId}::uuid, ${secondLeadId}::uuid, 'lead', NULL)
  `.execute(db);
  const at = created.toISOString();
  const fresh = now.toISOString();
  await sql`
    INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
    VALUES
      (${blockedId}::uuid, ${projectId}::uuid, 7, 'Ждёт', ${TASK_STATUS_BLOCKED}, 'normal', ${assigneeId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${reviewId}::uuid, ${projectId}::uuid, 10, 'На проверке', ${TASK_STATUS_REVIEW}, 'normal', ${assigneeId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${freshReviewId}::uuid, ${projectId}::uuid, 11, 'Свежая проверка', ${TASK_STATUS_REVIEW}, 'normal', ${assigneeId}::uuid, ${fresh}::timestamptz, ${fresh}::timestamptz),
      (${progressId}::uuid, ${projectId}::uuid, 8, 'В работе', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${assigneeId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${plannedId}::uuid, ${projectId}::uuid, 9, 'План', ${TASK_STATUS_PLANNED}, 'normal', ${assigneeId}::uuid, ${at}::timestamptz, ${at}::timestamptz),
      (${quietReviewId}::uuid, ${projectId}::uuid, 12, 'Без галочки в журнале', ${TASK_STATUS_REVIEW}, 'normal', ${assigneeId}::uuid, ${at}::timestamptz, ${at}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO blockers (id, task_id, reason, asked_at, resolved_at)
    VALUES (${blockerId}::uuid, ${blockedId}::uuid, NULL, ${at}::timestamptz, NULL)
  `.execute(db);
  const journal = createEventJournal(db, silentLogger);
  await emit(journal, {
    type: EVENT_TYPES.TASK_CHECKED,
    source: 'telegram',
    idempotencyKey: 'check-review',
    payload: { task_id: reviewId },
    actor: { id: assigneeId, role: 'assignee' },
    subject: { entity: 'Task', id: reviewId },
    occurredAt: created,
    causationId: null,
    correlationId: null,
  });
  await emit(journal, {
    type: EVENT_TYPES.TASK_CHECKED,
    source: 'telegram',
    idempotencyKey: 'check-fresh',
    payload: { task_id: freshReviewId },
    actor: { id: assigneeId, role: 'assignee' },
    subject: { entity: 'Task', id: freshReviewId },
    occurredAt: nextDay,
    causationId: null,
    correlationId: null,
  });
}

function clockAt(at: Date): Clock {
  return { now: () => at };
}

function questionReply() {
  return {
    messageId: 15,
    text: blockerQuestionText(7, questionDay),
    fromBot: true,
  };
}

async function reasonOf(db: Kysely<Database>): Promise<string | null> {
  const rows = await sql<{ reason: string | null }>`SELECT reason FROM blockers WHERE id = ${blockerId}::uuid`.execute(db);
  return rows.rows[0]?.reason ?? null;
}

async function statusOf(db: Kysely<Database>, id: string): Promise<string | undefined> {
  const rows = await sql<{ status: string }>`SELECT status FROM tasks WHERE id = ${id}::uuid`.execute(db);
  return rows.rows[0]?.status;
}

async function eventsOf(db: Kysely<Database>, type: string): Promise<{ key: string; payload: Record<string, unknown> }[]> {
  const rows = await sql<{ idempotency_key: string; payload: unknown }>`
    SELECT idempotency_key, payload FROM events WHERE event_type = ${type} ORDER BY created_at, idempotency_key
  `.execute(db);
  return rows.rows.map((row) => ({
    key: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown>),
  }));
}

describe('причина блокера и «нет блокера»', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-05 «нет блокера» ведёт только из BLOCKED в IN_PROGRESS; GitHub статус не меняет', () => {
    const move = transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_NO_BLOCKER);
    expect(move).toEqual({ from: TASK_STATUS_BLOCKED, to: TASK_STATUS_IN_PROGRESS, closesBlocker: true });
    expect(move.to).not.toBe(TASK_STATUS_DONE);
    for (const status of TASK_STATUSES) {
      if (status === TASK_STATUS_BLOCKED) continue;
      expect(() => transitionTask(status, TASK_TRANSITION_NO_BLOCKER)).toThrowError(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
      );
    }
    for (const type of GITHUB_FACT_TYPES) {
      expect(() => transitionTask(TASK_STATUS_BLOCKED, type)).toThrow(DomainError);
    }
  });

  it('INV-11 причина — только reply на вопрос бота об этой задаче', () => {
    expect(blockerQuestionText(7, questionDay)).toBe('7 не двигается 3-й день, что мешает?');
    expect(
      blockerQuestionReply({
        replyToMessageId: 15,
        repliedText: blockerQuestionText(7, questionDay),
        fromBot: true,
      }),
    ).toEqual({ replyToMessageId: 15, taskNumber: 7 });
    expect(blockerQuestionReply({ replyToMessageId: 15, repliedText: 'просто текст', fromBot: true })).toBeNull();
    expect(
      blockerQuestionReply({
        replyToMessageId: 15,
        repliedText: blockerQuestionText(7, questionDay),
        fromBot: false,
      }),
    ).toBeNull();
    expect(blockerQuestionReply({ replyToMessageId: null, repliedText: blockerQuestionText(7, questionDay), fromBot: true })).toBeNull();
    expect(() => questionReplyForTask({ replyToMessageId: null, questionTaskNumber: 7, taskNumber: 7 })).toThrowError(
      expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_REPLY }),
    );
    expect(() => questionReplyForTask({ replyToMessageId: 15, questionTaskNumber: 8, taskNumber: 7 })).toThrowError(
      expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_REPLY }),
    );
    expect(questionReplyForTask({ replyToMessageId: 15, questionTaskNumber: 7, taskNumber: 7 })).toEqual({ replyToMessageId: 15 });
    expect(() =>
      withBlockerReason(
        { id: blockerId, taskId: blockedId, reason: null, askedAt: created.toISOString(), resolvedAt: now.toISOString() },
        'ждёт',
      ),
    ).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.BLOCKER_ABSENT }));
  });

  it('R-329 ответ — это reply на вопрос бота', async () => {
    let declared = 0;
    const actions = {
      async declare() {
        declared += 1;
        throw new Error('не должен зваться');
      },
      async dismiss() {
        throw new Error('не должен зваться');
      },
    };
    const missed = await replyToBlockerReason(place, assignee, 'u1', 'ждёт заказчика', { messageId: 4, text: 'канвас', fromBot: true }, actions);
    expect(missed).toBeNull();
    const aside = await replyToBlockerReason(place, assignee, 'u2', 'ждёт заказчика', null, actions);
    expect(aside).toBeNull();
    expect(declared).toBe(0);
    expect(parseNoBlockerData('task:noblock:7')).toBe(7);
  });

  it('R-256 текст ответа становится причиной', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const actions = createBlockerAnswerActions(handle.db, silentLogger, clockAt(now));
    const declared = await replyToBlockerReason(place, assignee, 'update-1', '  ждёт заказчика  ', questionReply(), actions);
    expect(declared?.applied).toBe(true);
    expect(declared?.blocker.reason).toBe('ждёт заказчика');
    expect(await reasonOf(handle.db)).toBe('ждёт заказчика');
    expect(await statusOf(handle.db, blockedId)).toBe(TASK_STATUS_BLOCKED);
    const facts = await eventsOf(handle.db, EVENT_TYPES.BLOCKER_DECLARED);
    expect(facts).toEqual([
      { key: 'update-1', payload: { blocker_id: blockerId, reason: 'ждёт заказчика' } },
    ]);
  });

  it('INV-11 чужой текст и чужой номер причину не пишут', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const actions = createBlockerAnswerActions(handle.db, silentLogger, clockAt(now));
    const missed = await replyToBlockerReason(place, assignee, 'update-2', 'ждёт', { messageId: 9, text: 'другое', fromBot: true }, actions);
    expect(missed).toBeNull();
    expect(await reasonOf(handle.db)).toBeNull();
    await expect(
      actions.declare({
        telegramUserId: String(assignee.id),
        chat: TASK_TOPIC_CHAT,
        telegramChatId,
        topicId: topic,
        taskNumber: 7,
        reason: 'мимо',
        replyToMessageId: 15,
        questionTaskNumber: 8,
        idempotencyKey: 'update-3',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.BLOCKER_REPLY });
    expect(await reasonOf(handle.db)).toBeNull();
    expect(await eventsOf(handle.db, EVENT_TYPES.BLOCKER_DECLARED)).toEqual([]);
  });

  it('R-257 кнопка «нет блокера» возвращает задачу в IN_PROGRESS', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const actions = createBlockerAnswerActions(handle.db, silentLogger, clockAt(now));
    await replyToBlockerReason(place, assignee, 'update-1', 'ждёт заказчика', questionReply(), actions);
    const dismissed = await replyToNoBlocker(place, assignee, 'callback-1', 7, actions);
    expect(dismissed?.applied).toBe(true);
    expect(dismissed?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(dismissed?.closesBlocker).toBe(true);
    expect(await statusOf(handle.db, blockedId)).toBe(TASK_STATUS_IN_PROGRESS);
    const rows = await sql<{ reason: string | null; resolved_at: Date | null }>`
      SELECT reason, resolved_at FROM blockers WHERE id = ${blockerId}::uuid
    `.execute(handle.db);
    expect(rows.rows[0]?.reason).toBe('ждёт заказчика');
    expect(rows.rows[0]?.resolved_at).not.toBeNull();
    expect(await eventsOf(handle.db, EVENT_TYPES.BLOCKER_DISMISSED)).toEqual([
      { key: 'callback-1', payload: { blocker_id: blockerId, task_id: blockedId } },
    ]);
  });

  it('INV-22 повтор reply и повтор «нет блокера» не пишут второе событие', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const actions = createBlockerAnswerActions(handle.db, silentLogger, clockAt(now));
    await replyToBlockerReason(place, assignee, 'update-1', 'ждёт заказчика', questionReply(), actions);
    const again = await replyToBlockerReason(place, assignee, 'update-1', 'другая причина', questionReply(), actions);
    expect(again?.applied).toBe(false);
    expect(await reasonOf(handle.db)).toBe('ждёт заказчика');
    expect(await eventsOf(handle.db, EVENT_TYPES.BLOCKER_DECLARED)).toHaveLength(1);
    await replyToNoBlocker(place, assignee, 'callback-1', 7, actions);
    const repeated = await replyToNoBlocker(place, assignee, 'callback-1', 7, actions);
    expect(repeated?.applied).toBe(false);
    expect(await statusOf(handle.db, blockedId)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(await eventsOf(handle.db, EVENT_TYPES.BLOCKER_DISMISSED)).toHaveLength(1);
  });
});

describe('напоминание руководителям', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-330 упоминая руководителей проекта', () => {
    expect(reviewReminderText(10, [
      { telegramUserId: '1001', name: 'Аня' },
      { telegramUserId: '1003', name: 'Вера & Co' },
    ])).toBe(
      '10 на подтверждении, <a href="tg://user?id=1001">Аня</a>, <a href="tg://user?id=1003">Вера &amp; Co</a>',
    );
    expect(reviewReminderText(10, [])).toBe('10 на подтверждении');
  });

  it('INV-10 напоминание только о REVIEW дольше STALE_DAYS и не чаще того же порога', () => {
    expect(projectDaysBetween(created, now, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(projectDaysBetween(created, now, 'Etc/UTC')).toBe(STALE_DAYS - 1);
    const waiting = [{ type: EVENT_TYPES.TASK_CHECKED, occurredAt: created }];
    expect(reviewWaitingSince(waiting)?.toISOString()).toBe(created.toISOString());
    expect(reviewWaitingSince([{ type: EVENT_TYPES.TASK_CHECKED, occurredAt: created }, { type: EVENT_TYPES.TASK_RETURNED, occurredAt: now }])).toBeNull();
    const due = decideReviewReminder({
      status: TASK_STATUS_REVIEW,
      taskId: reviewId,
      timezone: 'Europe/Moscow',
      marks: waiting,
      leadIds: [leadId],
      now,
    });
    expect(due?.idempotencyKey).toBe(reviewRemindedKey(reviewId, projectCalendarDate(now, 'Europe/Moscow')));
    expect(due?.leadIds).toEqual([leadId]);
    expect(decideReviewReminder({
      status: TASK_STATUS_REVIEW,
      taskId: reviewId,
      timezone: 'Etc/UTC',
      marks: waiting,
      leadIds: [leadId],
      now,
    })).toBeNull();
    expect(decideReviewReminder({
      status: TASK_STATUS_IN_PROGRESS,
      taskId: progressId,
      timezone: 'Europe/Moscow',
      marks: waiting,
      leadIds: [leadId],
      now,
    })).toBeNull();
    expect(decideReviewReminder({
      status: TASK_STATUS_PLANNED,
      taskId: plannedId,
      timezone: 'Europe/Moscow',
      marks: [],
      leadIds: [leadId],
      now,
    })).toBeNull();
    expect(decideReviewReminder({
      status: TASK_STATUS_REVIEW,
      taskId: freshReviewId,
      timezone: 'Europe/Moscow',
      marks: [{ type: EVENT_TYPES.TASK_CHECKED, occurredAt: now }],
      leadIds: [leadId],
      now,
    })).toBeNull();
    const reminded = [...waiting, { type: EVENT_TYPES.REVIEW_REMINDED, occurredAt: now }];
    expect(lastReviewReminderAt(reminded)?.toISOString()).toBe(now.toISOString());
    expect(decideReviewReminder({
      status: TASK_STATUS_REVIEW,
      taskId: reviewId,
      timezone: 'Europe/Moscow',
      marks: reminded,
      leadIds: [leadId],
      now: nextDay,
    })).toBeNull();
    expect(projectDaysBetween(now, twoDaysLater, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(decideReviewReminder({
      status: TASK_STATUS_REVIEW,
      taskId: reviewId,
      timezone: 'Europe/Moscow',
      marks: reminded,
      leadIds: [leadId, secondLeadId],
      now: twoDaysLater,
    })?.idempotencyKey).toBe(reviewRemindedKey(reviewId, projectCalendarDate(twoDaysLater, 'Europe/Moscow')));
  });

  it('INV-10 R-261 бот напоминает в топике исполнителя один раз за два дня', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const sent: { text: string; thread: number | undefined; mode: string | undefined }[] = [];
    const api: Pick<Api, 'sendMessage'> = {
      async sendMessage(_chatId, text, extra) {
        sent.push({ text, thread: extra?.message_thread_id, mode: extra?.parse_mode });
        return { message_id: 1, date: 0, chat: { id: 0, type: 'supergroup' } } as Awaited<ReturnType<Api['sendMessage']>>;
      },
    };
    const hits: RemindedReview[] = [];
    await remindStaleReviews(handle.db, silentLogger, now, async (hit) => {
      hits.push(hit);
      await sendReviewReminder(api, {
        chatId: hit.telegramChatId,
        messageThreadId: hit.topicId,
        taskNumber: hit.taskNumber,
        leads: hit.leads,
      });
    });
    expect(hits.map((hit) => hit.taskId)).toEqual([reviewId]);
    expect(hits[0]?.topicId).toBe(topic);
    expect(hits[0]?.leads).toEqual([
      { telegramUserId: '1001', name: 'Аня' },
      { telegramUserId: '1003', name: 'Вера' },
    ]);
    expect(sent).toEqual([
      {
        text: reviewReminderText(10, hits[0]?.leads ?? []),
        thread: topic,
        mode: 'HTML',
      },
    ]);
    expect(await statusOf(handle.db, reviewId)).toBe(TASK_STATUS_REVIEW);
    const facts = await eventsOf(handle.db, EVENT_TYPES.REVIEW_REMINDED);
    expect(facts).toEqual([
      {
        key: reviewRemindedKey(reviewId, projectCalendarDate(now, 'Europe/Moscow')),
        payload: { task_id: reviewId, lead_ids: [leadId, secondLeadId] },
      },
    ]);
    await remindStaleReviews(handle.db, silentLogger, nextDay, async () => {
      throw new Error('рано');
    });
    expect(await eventsOf(handle.db, EVENT_TYPES.REVIEW_REMINDED)).toHaveLength(1);
    await remindStaleReviews(handle.db, silentLogger, twoDaysLater, async () => undefined);
    expect(await eventsOf(handle.db, EVENT_TYPES.REVIEW_REMINDED)).toHaveLength(2);
    expect(projectDaysBetween(now, nextDay, 'Europe/Moscow')).toBe(STALE_DAYS - 1);
  });

  it('INV-22 повтор хода не пишет второе напоминание', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const seen: string[] = [];
    await remindStaleReviews(handle.db, silentLogger, now, async (hit) => {
      seen.push(hit.taskId);
    });
    await remindStaleReviews(handle.db, silentLogger, now, async () => {
      throw new Error('повтор');
    });
    expect(seen).toEqual([reviewId]);
    expect(await eventsOf(handle.db, EVENT_TYPES.REVIEW_REMINDED)).toHaveLength(1);
    expect(await statusOf(handle.db, reviewId)).toBe(TASK_STATUS_REVIEW);
  });
});
