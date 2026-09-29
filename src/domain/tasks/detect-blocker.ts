import { EVENT_TYPES, emit, type EventJournal } from '../../events/index.ts';
import { projectCalendarDate, staleByProjectZone } from '../shared/project-time.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineBlocker, type Blocker } from './blocker.ts';
import { defineUnlinked } from './github-link.ts';
import { blockedByListSilence, TASK_STATUS_IN_PROGRESS, type TaskStatus } from './status.ts';
import { taskCanvasDay } from './task-day.ts';
import type { Task } from './task.ts';
import { TASK_TRANSITION_STALE, transitionTask } from './transition.ts';

/** Вопрос о блокере пишет система (A-28). */
export const BLOCKER_ACTOR_ID = 'system';

export const BLOCKER_ACTOR_ROLE = 'system';

export const BLOCKER_SUBJECT = 'Blocker';

export const BLOCKER_SOURCE = 'system';

/** Факт журнала по задаче: тип и момент. Порядок — как в журнале. */
export interface TaskJournalMark {
  type: string;
  occurredAt: Date;
}

export interface StaleBlock {
  day: number;
  idempotencyKey: string;
}

/**
 * Ключ `blocker.detected`: задача и дата проекта.
 * Повтор в те же сутки не пишет второй факт.
 */
export function blockerDetectedKey(taskId: string, date: string): string {
  return `${EVENT_TYPES.BLOCKER_DETECTED}+${taskId}+${date}`;
}

function opensSilence(type: string): boolean {
  return (
    type === EVENT_TYPES.TASK_CREATED ||
    type === EVENT_TYPES.TASK_UNCHECKED ||
    type === EVENT_TYPES.TASK_RETURNED ||
    type === EVENT_TYPES.TASK_RESUMED
  );
}

function closesSilence(type: string): boolean {
  return type === EVENT_TYPES.TASK_CHECKED || type === EVENT_TYPES.TASK_PLANNED;
}

/**
 * Начало текущего отрезка без галочки.
 * Галочка и уход в план отрезок закрывают. Вопрос о блокере его не сдвигает.
 * Журнала нет — отсчёт от создания. Отрезок закрыт — `null`.
 */
export function uncheckedSince(marks: readonly TaskJournalMark[], createdAt: Date): Date | null {
  let since: Date | null = null;
  let seen = false;
  for (const mark of marks) {
    if (opensSilence(mark.type)) {
      since = mark.occurredAt;
      seen = true;
    } else if (closesSilence(mark.type)) {
      since = null;
      seen = true;
    }
  }
  if (!seen) return createdAt;
  return since;
}

/** Момент последнего вопроса по задаче. Его нет — бот ещё не спрашивал. */
export function lastBlockerQuestionAt(marks: readonly TaskJournalMark[]): Date | null {
  let asked: Date | null = null;
  for (const mark of marks) {
    if (mark.type === EVENT_TYPES.BLOCKER_DETECTED) asked = mark.occurredAt;
  }
  return asked;
}

/**
 * A-28. Только `IN_PROGRESS` без галочки дольше `STALE_DAYS`.
 * `PLANNED` и `REVIEW` сюда не входят. Повторный вопрос — не раньше того же порога.
 * Порог один: и тишина галочки, и пауза между вопросами.
 */
export function decideStaleBlock(input: {
  status: TaskStatus;
  taskId: string;
  createdAt: Date;
  timezone: string;
  marks: readonly TaskJournalMark[];
  now: Date;
}): StaleBlock | null {
  if (input.status !== TASK_STATUS_IN_PROGRESS) return null;
  const since = uncheckedSince(input.marks, input.createdAt);
  if (since === null) return null;
  if (!blockedByListSilence(since, input.now, input.timezone)) return null;
  const asked = lastBlockerQuestionAt(input.marks);
  if (asked !== null && !staleByProjectZone(asked, input.now, input.timezone)) return null;
  const today = projectCalendarDate(input.now, input.timezone);
  const createdOn = projectCalendarDate(input.createdAt, input.timezone);
  return {
    day: taskCanvasDay(createdOn, today),
    idempotencyKey: blockerDetectedKey(input.taskId, today),
  };
}

export interface BlockerDetectStore {
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  insertBlocker(blocker: Blocker): Promise<void>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

/**
 * Записать застой: блокер без причины, статус `BLOCKED`, событие `blocker.detected`.
 * Повтор ключа вторую строку не пишет и статус не меняет.
 */
export async function publishBlockerDetected(
  store: BlockerDetectStore,
  journal: EventJournal,
  input: {
    task: Task;
    blockerId: string;
    day: number;
    idempotencyKey: string;
    occurredAt: Date;
  },
): Promise<{ applied: boolean; eventId: string }> {
  const prior = await store.seen(input.idempotencyKey);
  if (prior !== null) return { applied: false, eventId: prior.eventId };
  const move = transitionTask(input.task.status, TASK_TRANSITION_STALE);
  const blocker = defineBlocker({
    id: input.blockerId,
    taskId: input.task.id,
    reason: null,
    askedAt: input.occurredAt.toISOString(),
    resolvedAt: null,
  });
  const published = await emit(journal, {
    type: EVENT_TYPES.BLOCKER_DETECTED,
    source: BLOCKER_SOURCE,
    idempotencyKey: input.idempotencyKey,
    payload: {
      blocker_id: blocker.id,
      task_id: input.task.id,
      day: input.day,
    },
    actor: { id: BLOCKER_ACTOR_ID, role: BLOCKER_ACTOR_ROLE },
    subject: { entity: BLOCKER_SUBJECT, id: blocker.id },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  await store.insertBlocker(blocker);
  const next = defineUnlinked({
    ...input.task,
    status: move.to,
    updatedAt: input.occurredAt.toISOString(),
    completedAt: null,
  });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  return { applied: true, eventId: published.row.id };
}
