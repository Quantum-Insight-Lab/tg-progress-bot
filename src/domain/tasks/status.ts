import { staleByProjectZone } from '../shared/project-time.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** `PLANNED` — в плане. */
export const TASK_STATUS_PLANNED = 'PLANNED';

/** `IN_PROGRESS` — стоит в «Задачах» на канвасе исполнителя. */
export const TASK_STATUS_IN_PROGRESS = 'IN_PROGRESS';

/** `BLOCKED` — два дня в списке без галочки, причина выясняется. */
export const TASK_STATUS_BLOCKED = 'BLOCKED';

/** `REVIEW` — исполнитель поставил галочку, ждёт подтверждения руководителя. */
export const TASK_STATUS_REVIEW = 'REVIEW';

/** `DONE` — руководитель подтвердил. */
export const TASK_STATUS_DONE = 'DONE';

/** `CANCELLED` — делать не будем. */
export const TASK_STATUS_CANCELLED = 'CANCELLED';

/** Статусы задачи. Другого нет. */
export const TASK_STATUSES = [
  TASK_STATUS_PLANNED,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_REVIEW,
  TASK_STATUS_DONE,
  TASK_STATUS_CANCELLED,
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `high`. */
export const TASK_PRIORITY_HIGH = 'high';

/** `normal`. */
export const TASK_PRIORITY_NORMAL = 'normal';

/** `low`. */
export const TASK_PRIORITY_LOW = 'low';

/** Приоритеты задачи. Другого нет. */
export const TASK_PRIORITIES = [TASK_PRIORITY_HIGH, TASK_PRIORITY_NORMAL, TASK_PRIORITY_LOW] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

/** Статус задачи — один из шести. Пустая строка сюда не доходит: её отвергает поле. */
export function taskStatus(value: string): TaskStatus {
  const status = oneOf(value, TASK_STATUSES);
  if (status !== undefined) return status;
  throw new DomainError(
    DOMAIN_ERROR.TASK_STATUS,
    'Статус задачи — PLANNED, IN_PROGRESS, BLOCKED, REVIEW, DONE или CANCELLED',
  );
}

/** Приоритет задачи — high, normal или low. */
export function taskPriority(value: string): TaskPriority {
  const priority = oneOf(value, TASK_PRIORITIES);
  if (priority !== undefined) return priority;
  throw new DomainError(DOMAIN_ERROR.TASK_PRIORITY, 'Приоритет задачи — high, normal или low');
}

/**
 * В блоке «Задачи» стоят `IN_PROGRESS`, `BLOCKED` и `REVIEW`.
 * `PLANNED` остаётся в «Плане». Подтверждённая и снятая с канваса уходят.
 */
const TASKS_BLOCK_STATUSES = [TASK_STATUS_IN_PROGRESS, TASK_STATUS_BLOCKED, TASK_STATUS_REVIEW] as const;

export function standsInTasksBlock(status: TaskStatus): boolean {
  return oneOf(status, TASKS_BLOCK_STATUSES) !== undefined;
}

/** Задачи блока «Задачи» в исходном порядке. Остальные статусы строку не занимают. */
export function tasksStandingInBlock<T extends { status: TaskStatus }>(tasks: readonly T[]): T[] {
  const standing: T[] = [];
  for (const task of tasks) {
    if (standsInTasksBlock(task.status)) standing.push(task);
  }
  return standing;
}

/**
 * `BLOCKED`: задача стоит в списке без галочки не меньше `STALE_DAYS` суток проекта.
 * Переход статуса и вопрос исполнителю — отдельные акты.
 */
export function blockedByListSilence(lastMark: Date, now: Date, timezone: string): boolean {
  return staleByProjectZone(lastMark, now, timezone);
}

/** `BLOCKED`: причина ещё выясняется. Галочка её не называет. */
export function reasonBeingClarified(status: TaskStatus): boolean {
  return status === TASK_STATUS_BLOCKED;
}

/** `REVIEW`: ждёт подтверждения руководителя. */
export function awaitsLeadConfirmation(status: TaskStatus): boolean {
  return status === TASK_STATUS_REVIEW;
}
