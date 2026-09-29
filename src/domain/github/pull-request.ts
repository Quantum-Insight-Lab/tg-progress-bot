import { DOMAIN_ERROR, DomainError, type DomainErrorCode } from '../shared/errors.ts';
import { ciStatus, type CiStatus } from './ci-status.ts';
import { githubRepositoryId } from './repository.ts';

/** Pull request открыт. */
export const PULL_REQUEST_STATE_OPEN = 'open';

/** Pull request закрыт без слияния. */
export const PULL_REQUEST_STATE_CLOSED = 'closed';

/** Pull request смержен. */
export const PULL_REQUEST_STATE_MERGED = 'merged';

/** Состояния pull request. Другого нет. */
export const PULL_REQUEST_STATES = [
  PULL_REQUEST_STATE_OPEN,
  PULL_REQUEST_STATE_CLOSED,
  PULL_REQUEST_STATE_MERGED,
] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * Pull request зеркала (E-14): открытый или смерженный PR с автором и CI.
 * Ключ — id. Природный ключ — репозиторий и номер, не проект и не задача.
 * `ciStatus` пуст, пока workflow этого PR не завершился.
 * `mergedAt` и `mergedByLogin` пусты, пока PR не смержен.
 */
export interface PullRequest {
  id: string;
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: PullRequestState;
  ciStatus: CiStatus | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

function pullRequestState(value: string): PullRequestState {
  const state = oneOf(value.trim(), PULL_REQUEST_STATES);
  if (state !== undefined) return state;
  throw new DomainError(
    DOMAIN_ERROR.PULL_REQUEST_STATE,
    'Состояние pull request — open, closed или merged',
  );
}

function pullRequestNumberOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_NUMBER, 'Номер pull request — положительное число GitHub');
  }
  return value;
}

function authorLoginOf(value: string): string {
  const login = value.trim();
  if (login.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_AUTHOR_LOGIN, 'У pull request есть автор');
  }
  return login;
}

function timestamp(value: string, code: DomainErrorCode, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new DomainError(code, message);
  }
  return trimmed;
}

function optionalTimestamp(value: string | null, code: DomainErrorCode, message: string): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return timestamp(trimmed, code, message);
}

function optionalLogin(value: string | null): string | null {
  if (value === null) return null;
  const login = value.trim();
  if (login.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_MERGED_BY_LOGIN, 'Логин слившего либо пуст, либо задан');
  }
  return login;
}

function optionalCiStatus(value: string | null): CiStatus | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return ciStatus(trimmed);
}

function mergeFields(
  state: PullRequestState,
  mergedAt: string | null,
  mergedByLogin: string | null,
): { mergedAt: string | null; mergedByLogin: string | null } {
  if (state !== PULL_REQUEST_STATE_MERGED) return { mergedAt: null, mergedByLogin: null };
  return {
    mergedAt: optionalTimestamp(mergedAt, DOMAIN_ERROR.PULL_REQUEST_MERGED_AT, 'Дата слияния — метка времени или пусто'),
    mergedByLogin: optionalLogin(mergedByLogin),
  };
}

/** Поля pull request без id. Проекта и задачи среди них нет. */
export function pullRequestFields(input: {
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: string;
  ciStatus: string | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
}): Omit<PullRequest, 'id'> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_TITLE_BLANK, 'У pull request есть название');
  }
  const state = pullRequestState(input.state);
  const merged = mergeFields(state, input.mergedAt, input.mergedByLogin);
  return {
    repositoryId: githubRepositoryId(input.repositoryId),
    pullRequestNumber: pullRequestNumberOf(input.pullRequestNumber),
    title,
    authorLogin: authorLoginOf(input.authorLogin),
    state,
    ciStatus: optionalCiStatus(input.ciStatus),
    updatedAt: timestamp(input.updatedAt, DOMAIN_ERROR.PULL_REQUEST_UPDATED_AT, 'Дата pull request — метка времени'),
    mergedAt: merged.mergedAt,
    mergedByLogin: merged.mergedByLogin,
  };
}

/** Поля pull request. Автор — логин того, кто открыл PR. */
export function definePullRequest(input: {
  id: string;
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: string;
  ciStatus: string | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
}): PullRequest {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_ID_BLANK, 'У pull request есть id');
  }
  return { id: input.id.trim(), ...pullRequestFields(input) };
}

/** Природный ключ pull request: репозиторий и номер. Проекта в ключе нет. */
export function pullRequestNaturalKey(
  repositoryId: string,
  pullRequestNumber: number,
): { repositoryId: string; pullRequestNumber: number } {
  return {
    repositoryId: githubRepositoryId(repositoryId),
    pullRequestNumber: pullRequestNumberOf(pullRequestNumber),
  };
}
