import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
} from './backlog-share.ts';

/**
 * Место человека в бэклоге проекта.
 * Считается на лету по issues репозитория и текущему `github_login`.
 * Задачи бота в срез не входят и статус задачи от чтения не меняется.
 */

/** Среза нет: логин не записан. */
export const PERSON_PLACE_UNMATCHED = 'unmatched';

/** Среза нет: репозиторий проекта не подключён. */
export const PERSON_PLACE_ABSENT = 'absent';

/** Срез есть: сделал, сейчас, дальше. */
export const PERSON_PLACE_SLICE = 'slice';

/**
 * Чтение места — не акт перехода задачи.
 * Таблица переходов такой строки не содержит, статус остаётся прежним.
 */
export const PERSON_PLACE_READ = 'person.place';

/** Issue репозитория и его assignees. Задачи дня здесь нет. */
export interface PersonBacklogIssue {
  repositoryId: string;
  issueNumber: number;
  state: string;
  stateReason: string | null;
  assignees: readonly string[];
}

/** Без логина сопоставления с GitHub нет. */
export interface PersonPlaceUnmatched {
  kind: typeof PERSON_PLACE_UNMATCHED;
}

/** Репозиторий не подключён: места в бэклоге нет. */
export interface PersonPlaceAbsent {
  kind: typeof PERSON_PLACE_ABSENT;
}

/**
 * Место одного человека в одном репозитории.
 * Номера — issues этого репозитория, каждый один раз.
 */
export interface PersonPlaceSlice {
  kind: typeof PERSON_PLACE_SLICE;
  /** Закрытые как `completed`, где среди assignees есть логин человека. */
  done: readonly number[];
  /** Открытые, где среди assignees есть логин человека. */
  now: readonly number[];
  /** Остальные открытые issues того же репозитория. */
  next: readonly number[];
}

export type PersonBacklogPlace = PersonPlaceUnmatched | PersonPlaceAbsent | PersonPlaceSlice;

type IssueSlot = 'open' | 'completed' | 'outside';

function githubId(value: string): string {
  const id = value.trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'id репозитория — id GitHub');
  }
  return id;
}

function repositoryOf(value: string | null): string | null {
  if (value === null) return null;
  const id = value.trim();
  if (id.length === 0) return null;
  return githubId(id);
}

function issueNumberOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'Номер issue — положительное число GitHub');
  }
  return value;
}

function issueState(value: string): typeof BACKLOG_ISSUE_OPEN | typeof BACKLOG_ISSUE_CLOSED {
  const state = value.trim();
  if (state === BACKLOG_ISSUE_OPEN) return BACKLOG_ISSUE_OPEN;
  if (state === BACKLOG_ISSUE_CLOSED) return BACKLOG_ISSUE_CLOSED;
  throw new DomainError(DOMAIN_ERROR.ISSUE_STATE, 'Состояние issue — open или closed');
}

function issueStateReason(value: string | null): typeof BACKLOG_ISSUE_COMPLETED | typeof BACKLOG_ISSUE_NOT_PLANNED | null {
  if (value === null) return null;
  const reason = value.trim();
  if (reason.length === 0) {
    throw new DomainError(
      DOMAIN_ERROR.ISSUE_STATE_REASON,
      'Причина закрытия — completed или not_planned, у открытого пусто',
    );
  }
  if (reason === BACKLOG_ISSUE_COMPLETED) return BACKLOG_ISSUE_COMPLETED;
  if (reason === BACKLOG_ISSUE_NOT_PLANNED) return BACKLOG_ISSUE_NOT_PLANNED;
  throw new DomainError(
    DOMAIN_ERROR.ISSUE_STATE_REASON,
    'Причина закрытия — completed или not_planned, у открытого пусто',
  );
}

function slot(state: string, stateReason: string | null): IssueSlot {
  const current = issueState(state);
  const reason = issueStateReason(stateReason);
  if (current === BACKLOG_ISSUE_OPEN) {
    if (reason !== null) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_STATE_REASON, 'У открытого issue причина пуста');
    }
    return 'open';
  }
  if (reason === BACKLOG_ISSUE_COMPLETED) return 'completed';
  if (reason === BACKLOG_ISSUE_NOT_PLANNED) return 'outside';
  throw new DomainError(
    DOMAIN_ERROR.ISSUE_STATE_REASON,
    'У закрытого issue причина — completed или not_planned',
  );
}

function assigneeLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of logins) {
    const login = normalizeGithubLogin(value);
    if (login === null) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_ASSIGNEE_LOGIN, 'У assignee есть логин');
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(login);
  }
  return unique;
}

function assignedTo(logins: readonly string[], githubLogin: string): boolean {
  for (const login of logins) {
    if (matchesCurrentGithubLogin(githubLogin, login)) return true;
  }
  return false;
}

function byNumber(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface ClassifiedIssue {
  issueNumber: number;
  slot: IssueSlot;
  assignees: readonly string[];
}

function classify(repositoryId: string, issues: readonly PersonBacklogIssue[]): ClassifiedIssue[] {
  const seen = new Set<number>();
  const rows: ClassifiedIssue[] = [];
  for (const issue of issues) {
    const repository = githubId(issue.repositoryId);
    if (repository !== repositoryId) {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'issue другого репозитория в срез человека не входит');
    }
    const issueNumber = issueNumberOf(issue.issueNumber);
    if (seen.has(issueNumber)) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'issue репозитория уже есть в списке');
    }
    seen.add(issueNumber);
    rows.push({
      issueNumber,
      slot: slot(issue.state, issue.stateReason),
      assignees: assigneeLogins(issue.assignees),
    });
  }
  return rows;
}

/**
 * Чтение места статус задачи не меняет.
 * Акт чтения не стоит в таблице переходов.
 */
export function placeChangesTaskStatus(): false {
  return false;
}

/**
 * Место человека в проекте по issues одного репозитория.
 * Issue относится к человеку, если среди assignees есть его текущий `github_login`.
 * Без репозитория места нет: это не пустой срез и не «нет сопоставления».
 * Без логина у подключённого репозитория среза нет. Пустой подключённый репозиторий при записанном логине — пустой срез.
 * Закрытый как `not_planned` не попадает ни в одну строку.
 */
export function personBacklogPlace(
  githubLogin: string | null,
  repositoryId: string | null,
  issues: readonly PersonBacklogIssue[],
): PersonBacklogPlace {
  const login = normalizeGithubLogin(githubLogin);
  const repository = repositoryOf(repositoryId);
  if (repository === null) {
    if (issues.length !== 0) {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'без репозитория issues в срез человека не входят');
    }
    return { kind: PERSON_PLACE_ABSENT };
  }
  const rows = classify(repository, issues);
  if (login === null) return { kind: PERSON_PLACE_UNMATCHED };
  const done: number[] = [];
  const now: number[] = [];
  const next: number[] = [];
  for (const row of rows) {
    const mine = assignedTo(row.assignees, login);
    if (row.slot === 'completed' && mine) done.push(row.issueNumber);
    if (row.slot === 'open' && mine) now.push(row.issueNumber);
    if (row.slot === 'open' && !mine) next.push(row.issueNumber);
  }
  done.sort(byNumber);
  now.sort(byNumber);
  next.sort(byNumber);
  return { kind: PERSON_PLACE_SLICE, done, now, next };
}
