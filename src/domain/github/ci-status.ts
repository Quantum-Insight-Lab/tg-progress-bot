import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** CI основной ветки или pull request завершился успешно. */
export const CI_STATUS_SUCCESS = 'success';

/** CI завершился с ошибкой. */
export const CI_STATUS_FAILURE = 'failure';

/** CI отменён. */
export const CI_STATUS_CANCELLED = 'cancelled';

/** Завершение, которое зеркало не различает: skipped, timed_out и прочие. */
export const CI_STATUS_OTHER = 'other';

/** Закрытый перечень статуса CI. Пустое значение — CI ещё неизвестен. */
export const CI_STATUSES = [
  CI_STATUS_SUCCESS,
  CI_STATUS_FAILURE,
  CI_STATUS_CANCELLED,
  CI_STATUS_OTHER,
] as const;

export type CiStatus = (typeof CI_STATUSES)[number];

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

/** Статус CI зеркала. Пустая строка статусом не является. */
export function ciStatus(value: string): CiStatus {
  const status = oneOf(value.trim().toLowerCase(), CI_STATUSES);
  if (status !== undefined) return status;
  throw new DomainError(DOMAIN_ERROR.CI_STATUS, 'Статус CI — success, failure, cancelled или other');
}

/** Пусто, пока workflow не завершился. Иное слово GitHub сворачивается в `other`. */
export function workflowConclusion(value: string | null): CiStatus | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const known = oneOf(trimmed, CI_STATUSES);
  return known ?? CI_STATUS_OTHER;
}

/** Ветка факта workflow. В зеркало имя ветки не пишется. */
export function ciBranch(value: string): string {
  const branch = value.trim();
  if (branch.length === 0) {
    throw new DomainError(DOMAIN_ERROR.CI_BRANCH, 'У workflow есть ветка');
  }
  return branch;
}
