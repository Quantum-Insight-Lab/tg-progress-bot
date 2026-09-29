import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { projectCalendarDate, staleByProjectZone } from '../shared/project-time.ts';
import { BLOCKER_ACTOR_ID, BLOCKER_ACTOR_ROLE, BLOCKER_SOURCE, type TaskJournalMark } from './detect-blocker.ts';
import { TASK_SUBJECT } from './create-task.ts';
import { TASK_STATUS_REVIEW, type TaskStatus } from './status.ts';

export interface ReviewReminder {
  idempotencyKey: string;
  leadIds: readonly string[];
}

/** Ключ `review.reminded`: задача и дата проекта. Повтор в те же сутки не пишет второй факт. */
export function reviewRemindedKey(taskId: string, date: string): string {
  return `${EVENT_TYPES.REVIEW_REMINDED}+${taskId}+${date}`;
}

function reviewOpened(type: string): boolean {
  return type === EVENT_TYPES.TASK_CHECKED;
}

function reviewClosed(type: string): boolean {
  return type === EVENT_TYPES.TASK_UNCHECKED || type === EVENT_TYPES.TASK_RETURNED || type === EVENT_TYPES.TASK_CONFIRMED;
}

/**
 * Начало текущего ожидания подтверждения.
 * Галочка отрезок открывает. Снятие, возврат и подтверждение его закрывают.
 */
export function reviewWaitingSince(marks: readonly TaskJournalMark[]): Date | null {
  let since: Date | null = null;
  for (const mark of marks) {
    if (reviewOpened(mark.type)) since = mark.occurredAt;
    else if (reviewClosed(mark.type)) since = null;
  }
  return since;
}

/** Момент последнего напоминания руководителям. Его нет — бот ещё не напоминал. */
export function lastReviewReminderAt(marks: readonly TaskJournalMark[]): Date | null {
  let reminded: Date | null = null;
  for (const mark of marks) {
    if (mark.type === EVENT_TYPES.REVIEW_REMINDED) reminded = mark.occurredAt;
  }
  return reminded;
}

/**
 * A-29. Только `REVIEW` дольше `STALE_DAYS` без подтверждения и возврата.
 * Напоминание — не чаще того же порога. Время берётся из журнала.
 */
export function decideReviewReminder(input: {
  status: TaskStatus;
  taskId: string;
  timezone: string;
  marks: readonly TaskJournalMark[];
  leadIds: readonly string[];
  now: Date;
}): ReviewReminder | null {
  if (input.status !== TASK_STATUS_REVIEW) return null;
  const since = reviewWaitingSince(input.marks);
  if (since === null) return null;
  if (!staleByProjectZone(since, input.now, input.timezone)) return null;
  const reminded = lastReviewReminderAt(input.marks);
  if (reminded !== null && !staleByProjectZone(reminded, input.now, input.timezone)) return null;
  return {
    idempotencyKey: reviewRemindedKey(input.taskId, projectCalendarDate(input.now, input.timezone)),
    leadIds: input.leadIds,
  };
}

export interface ReviewRemindStore {
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
}

/**
 * Записать напоминание. Повтор ключа второе событие не пишет.
 * Статус задачи это напоминание не меняет.
 */
export async function publishReviewReminded(
  store: ReviewRemindStore,
  journal: EventJournal,
  input: {
    taskId: string;
    leadIds: readonly string[];
    idempotencyKey: string;
    occurredAt: Date;
  },
): Promise<{ applied: boolean; eventId: string }> {
  const prior = await store.seen(input.idempotencyKey);
  if (prior !== null) return { applied: false, eventId: prior.eventId };
  const published = await emit(journal, {
    type: EVENT_TYPES.REVIEW_REMINDED,
    source: BLOCKER_SOURCE,
    idempotencyKey: input.idempotencyKey,
    payload: { task_id: input.taskId, lead_ids: [...input.leadIds] },
    actor: { id: BLOCKER_ACTOR_ID, role: BLOCKER_ACTOR_ROLE },
    subject: { entity: TASK_SUBJECT, id: input.taskId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  return { applied: true, eventId: published.row.id };
}
