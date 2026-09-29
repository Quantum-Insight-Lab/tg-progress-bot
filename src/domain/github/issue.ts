import { DOMAIN_ERROR, DomainError, type DomainErrorCode } from '../shared/errors.ts';
import { githubRepositoryId } from './repository.ts';

/** Issue открыт. `state_reason` у такого пуст. */
export const ISSUE_STATE_OPEN = 'open';

/** Issue закрыт. */
export const ISSUE_STATE_CLOSED = 'closed';

/** Состояния issue. Другого нет. */
export const ISSUE_STATES = [ISSUE_STATE_OPEN, ISSUE_STATE_CLOSED] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

/** Закрыт как сделанный. */
export const ISSUE_STATE_REASON_COMPLETED = 'completed';

/** Закрыт как не запланированный. */
export const ISSUE_STATE_REASON_NOT_PLANNED = 'not_planned';

/** Причины закрытия. У открытого issue причина пуста. */
export const ISSUE_STATE_REASONS = [ISSUE_STATE_REASON_COMPLETED, ISSUE_STATE_REASON_NOT_PLANNED] as const;

export type IssueStateReason = (typeof ISSUE_STATE_REASONS)[number];

/**
 * Issue зеркала (E-10): единица бэклога репозитория.
 * Ключ — id. Природный ключ репозитория и номера этой записью не задаётся.
 * Проекта в строке нет.
 */
export interface Issue {
  id: string;
  repositoryId: string;
  issueNumber: number;
  title: string;
  state: IssueState;
  /** `completed` или `not_planned`. Пусто у открытого. */
  stateReason: IssueStateReason | null;
  closedByLogin: string | null;
  updatedAt: string;
  closedAt: string | null;
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

function issueState(value: string): IssueState {
  const state = oneOf(value.trim(), ISSUE_STATES);
  if (state !== undefined) return state;
  throw new DomainError(DOMAIN_ERROR.ISSUE_STATE, 'Состояние issue — open или closed');
}

function issueStateReason(state: IssueState, value: string | null): IssueStateReason | null {
  if (value !== null && blank(value)) {
    throw new DomainError(
      DOMAIN_ERROR.ISSUE_STATE_REASON,
      'Причина закрытия — completed или not_planned, у открытого пусто',
    );
  }
  if (value === null) {
    return null;
  }
  const reason = oneOf(value.trim(), ISSUE_STATE_REASONS);
  if (reason === undefined) {
    throw new DomainError(
      DOMAIN_ERROR.ISSUE_STATE_REASON,
      'Причина закрытия — completed или not_planned, у открытого пусто',
    );
  }
  if (state === ISSUE_STATE_OPEN) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_STATE_REASON, 'У открытого issue причина пуста');
  }
  return reason;
}

function optionalLogin(value: string | null): string | null {
  if (value === null) return null;
  const login = value.trim();
  if (login.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_CLOSED_BY_LOGIN, 'Логин закрывшего либо пуст, либо задан');
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

/** Поля issue. Причина закрытия пуста, пока issue открыт. */
export function defineIssue(input: {
  id: string;
  repositoryId: string;
  issueNumber: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedByLogin: string | null;
  updatedAt: string;
  closedAt: string | null;
}): Issue {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_ID_BLANK, 'У issue есть id');
  }
  const repositoryId = githubRepositoryId(input.repositoryId);
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'Номер issue — положительное число GitHub');
  }
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_TITLE_BLANK, 'У issue есть название');
  }
  const state = issueState(input.state);
  return {
    id: input.id,
    repositoryId,
    issueNumber: input.issueNumber,
    title,
    state,
    stateReason: issueStateReason(state, input.stateReason),
    closedByLogin: optionalLogin(input.closedByLogin),
    updatedAt: timestamp(input.updatedAt, DOMAIN_ERROR.ISSUE_UPDATED_AT, 'У issue есть дата изменения'),
    closedAt:
      input.closedAt === null
        ? null
        : timestamp(input.closedAt, DOMAIN_ERROR.ISSUE_CLOSED_AT, 'Дата закрытия либо пуста, либо задана'),
  };
}
