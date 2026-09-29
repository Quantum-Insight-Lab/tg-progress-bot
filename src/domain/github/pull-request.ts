import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
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
 * Pull request зеркала (E-14): открытый или смерженный PR с автором.
 * Ключ — id. Природный ключ — репозиторий и номер, не проект и не задача.
 * `ci_status`, даты и логин слившего — в следующей issue.
 */
export interface PullRequest {
  id: string;
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: PullRequestState;
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

/** Поля pull request без id. Проекта и задачи среди них нет. */
export function pullRequestFields(input: {
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: string;
}): Omit<PullRequest, 'id'> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_TITLE_BLANK, 'У pull request есть название');
  }
  return {
    repositoryId: githubRepositoryId(input.repositoryId),
    pullRequestNumber: pullRequestNumberOf(input.pullRequestNumber),
    title,
    authorLogin: authorLoginOf(input.authorLogin),
    state: pullRequestState(input.state),
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
