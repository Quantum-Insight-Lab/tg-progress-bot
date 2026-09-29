import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * Блокер задачи. Причина — ответ исполнителя и пуста, пока ответа нет.
 * Открыт, пока `resolvedAt` пуст. Строки CI и PR сюда не входят.
 */
export interface Blocker {
  id: string;
  taskId: string;
  reason: string | null;
  askedAt: string;
  resolvedAt: string | null;
}

/** Колонок зеркала нет: CI, PR и issue в эту строку не пишутся. */
export const ABSENT_BLOCKER_MIRROR_FIELDS = [
  'ci',
  'ci_status',
  'default_branch_ci',
  'pull_request',
  'pull_request_id',
  'pull_request_number',
  'pr',
  'repository_id',
  'issue_id',
  'issue_number',
] as const;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function mirrorField(key: string): boolean {
  for (const field of ABSENT_BLOCKER_MIRROR_FIELDS) {
    if (field === key) return true;
  }
  return false;
}

/** Поля блокера. Чужой субъект — CI, PR, issue — отклоняется. */
export function defineBlocker(input: {
  id: string;
  taskId: string;
  reason: string | null;
  askedAt: string;
  resolvedAt: string | null;
}): Blocker {
  for (const key of Object.keys(input)) {
    if (mirrorField(key)) {
      throw new DomainError(DOMAIN_ERROR.BLOCKER_NOT_TASK, 'Только блокеры задач: строки про CI и PR сюда не пишутся');
    }
  }
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ID_BLANK, 'У блокера есть id');
  }
  if (blank(input.taskId)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_TASK_BLANK, 'Блокер есть только у задачи');
  }
  if (input.reason !== null && blank(input.reason)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_REASON, 'Причина — ответ исполнителя');
  }
  if (blank(input.askedAt)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ASKED_AT, 'У блокера есть момент вопроса');
  }
  if (input.resolvedAt !== null && blank(input.resolvedAt)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_RESOLVED_AT, 'Момент закрытия либо пуст, либо задан');
  }
  return {
    id: input.id,
    taskId: input.taskId,
    reason: input.reason === null ? null : input.reason.trim(),
    askedAt: input.askedAt.trim(),
    resolvedAt: input.resolvedAt === null ? null : input.resolvedAt.trim(),
  };
}

/** Открытый блокер: задача ещё не вышла из `BLOCKED` этим путём. */
export function isOpenBlocker(blocker: Blocker): boolean {
  return blocker.resolvedAt === null;
}

/**
 * Закрыть блокер в момент выхода задачи из `BLOCKED`.
 * Уже закрытый сохраняет свой `resolvedAt`.
 */
export function closeBlocker(blocker: Blocker, resolvedAt: string): Blocker {
  if (!isOpenBlocker(blocker)) return blocker;
  return defineBlocker({ ...blocker, resolvedAt });
}
