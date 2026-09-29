import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
} from './backlog-share.ts';

/**
 * Срез issues канваса (P-5).
 * «Сделано» — `completed`, сначала позже закрытые.
 * «В работе» — открытые с assignee, по номеру.
 * «Далее» — открытые без assignee, по номеру.
 * Голова списка — то, что остаётся после лимита среза.
 * Связь не добавляет issue в список: она только помечает тот, который и так выбран.
 * `not_planned` не входит ни в одну часть.
 */

/** Связь `blocked by`: этот issue заблокирован `dependsOnIssueNumber`. */
const CANVAS_SLICE_LINK_BLOCKED_BY = 'blocked_by';

/** Связь sub-issue: `dependsOnIssueNumber` — подзадача этого issue. */
const CANVAS_SLICE_LINK_SUB_ISSUE = 'sub_issue';

/** Пользователь бота. Имя на канвасе берётся по текущему `github_login`. */
export interface CanvasSliceUser {
  githubLogin: string | null;
  name: string;
}

/** Связь issue внутри репозитория. Цель — номер, не id. */
export interface CanvasSliceLink {
  dependsOnIssueNumber: number;
  linkType: string;
}

/** Issue зеркала для среза канваса. Задачи дня сюда не подставляются. */
export interface CanvasMirrorIssue {
  repositoryId: string;
  issueNumber: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedAt: string | null;
  assignees: readonly string[];
  links: readonly CanvasSliceLink[];
}

/** Пункт «Сделано» или «Далее»: номер, название и связи этого issue. */
export interface CanvasSliceItem {
  number: number;
  title: string;
  blockedBy: readonly number[];
  subIssues: readonly number[];
}

/** Пункт «В работе»: к названию — имя assignee. */
export interface CanvasSliceInProgressItem extends CanvasSliceItem {
  assigneeName: string;
}

/** Три части среза. Пустой список на канвасе не печатается. */
export interface CanvasIssueSlice {
  done: readonly CanvasSliceItem[];
  inProgress: readonly CanvasSliceInProgressItem[];
  next: readonly CanvasSliceItem[];
}

type IssueSlot = 'open' | 'completed' | 'outside';

interface RankedIssue {
  issueNumber: number;
  title: string;
  slot: IssueSlot;
  closedAtMs: number | null;
  assignees: readonly string[];
  blockedBy: readonly number[];
  subIssues: readonly number[];
}

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

function issueTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_TITLE_BLANK, 'У issue есть название');
  }
  return title;
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

function closedInstant(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_CLOSED_AT, 'Дата закрытия либо пуста, либо задана');
  }
  return Date.parse(trimmed);
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

function linkKind(value: string): typeof CANVAS_SLICE_LINK_BLOCKED_BY | typeof CANVAS_SLICE_LINK_SUB_ISSUE {
  const kind = value.trim();
  if (kind === CANVAS_SLICE_LINK_BLOCKED_BY) return CANVAS_SLICE_LINK_BLOCKED_BY;
  if (kind === CANVAS_SLICE_LINK_SUB_ISSUE) return CANVAS_SLICE_LINK_SUB_ISSUE;
  throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_TYPE, 'связь — blocked_by или sub_issue');
}

function linksOf(
  issueNumber: number,
  links: readonly CanvasSliceLink[],
): { blockedBy: number[]; subIssues: number[] } {
  const blocked = new Set<number>();
  const subs = new Set<number>();
  for (const link of links) {
    const target = issueNumberOf(link.dependsOnIssueNumber);
    if (target === issueNumber) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_SELF, 'issue не зависит от себя');
    }
    if (linkKind(link.linkType) === CANVAS_SLICE_LINK_BLOCKED_BY) blocked.add(target);
    else subs.add(target);
  }
  return {
    blockedBy: [...blocked].sort(byNumber),
    subIssues: [...subs].sort(byNumber),
  };
}

function byNumber(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function byLogin(left: string, right: string): number {
  const order = left.toLowerCase().localeCompare(right.toLowerCase());
  if (order < 0) return -1;
  if (order > 0) return 1;
  return 0;
}

function byLatestClosed(left: RankedIssue, right: RankedIssue): number {
  if (left.closedAtMs !== null && right.closedAtMs !== null && left.closedAtMs !== right.closedAtMs) {
    return left.closedAtMs < right.closedAtMs ? 1 : -1;
  }
  if (left.closedAtMs === null && right.closedAtMs !== null) return 1;
  if (left.closedAtMs !== null && right.closedAtMs === null) return -1;
  return byNumber(left.issueNumber, right.issueNumber);
}

function labelOf(login: string, users: readonly CanvasSliceUser[]): string {
  for (const user of users) {
    if (!matchesCurrentGithubLogin(user.githubLogin, login)) continue;
    const name = user.name.trim();
    if (name.length > 0) return name;
  }
  return `@${login}`;
}

/** Имя пользователя бота, иначе `@login`. Несколько — через запятую, по логину. */
function assigneeLabel(logins: readonly string[], users: readonly CanvasSliceUser[]): string {
  const labels: string[] = [];
  const ordered = [...logins].sort(byLogin);
  for (const login of ordered) labels.push(labelOf(login, users));
  return labels.join(', ');
}

function classify(repositoryId: string, issues: readonly CanvasMirrorIssue[]): RankedIssue[] {
  const seen = new Set<number>();
  const rows: RankedIssue[] = [];
  for (const issue of issues) {
    const repository = githubId(issue.repositoryId);
    if (repository !== repositoryId) {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'issue другого репозитория в срез канваса не входит');
    }
    const issueNumber = issueNumberOf(issue.issueNumber);
    if (seen.has(issueNumber)) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'issue репозитория уже есть в списке');
    }
    seen.add(issueNumber);
    const links = linksOf(issueNumber, issue.links);
    rows.push({
      issueNumber,
      title: issueTitle(issue.title),
      slot: slot(issue.state, issue.stateReason),
      closedAtMs: closedInstant(issue.closedAt),
      assignees: assigneeLogins(issue.assignees),
      blockedBy: links.blockedBy,
      subIssues: links.subIssues,
    });
  }
  return rows;
}

function itemOf(row: RankedIssue): CanvasSliceItem {
  return {
    number: row.issueNumber,
    title: row.title,
    blockedBy: row.blockedBy,
    subIssues: row.subIssues,
  };
}

/**
 * Три списка issues одного репозитория.
 * Без репозитория списки пустые. Закрытый как `not_planned` никуда не попадает.
 */
export function canvasIssueSlice(
  repositoryId: string | null,
  issues: readonly CanvasMirrorIssue[],
  users: readonly CanvasSliceUser[],
): CanvasIssueSlice {
  const repository = repositoryOf(repositoryId);
  if (repository === null) {
    if (issues.length !== 0) {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'без репозитория issues в срез канваса не входят');
    }
    return { done: [], inProgress: [], next: [] };
  }
  const completed: RankedIssue[] = [];
  const working: RankedIssue[] = [];
  const waiting: RankedIssue[] = [];
  for (const row of classify(repository, issues)) {
    if (row.slot === 'completed') completed.push(row);
    if (row.slot === 'open' && row.assignees.length > 0) working.push(row);
    if (row.slot === 'open' && row.assignees.length === 0) waiting.push(row);
  }
  completed.sort(byLatestClosed);
  working.sort((left, right) => byNumber(left.issueNumber, right.issueNumber));
  waiting.sort((left, right) => byNumber(left.issueNumber, right.issueNumber));
  return {
    done: completed.map(itemOf),
    inProgress: working.map((row) => ({ ...itemOf(row), assigneeName: assigneeLabel(row.assignees, users) })),
    next: waiting.map(itemOf),
  };
}
