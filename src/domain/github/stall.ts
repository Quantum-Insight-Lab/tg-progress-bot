import { EVENT_TYPES, emit, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import { projectCalendarDate, projectDaysBetween, staleByProjectZone } from '../shared/project-time.ts';
import { CI_STATUS_FAILURE, type CiStatus } from './ci-status.ts';
import {
  PULL_REQUEST_STATE_OPEN,
  PULL_REQUEST_STATES,
  pullRequestNaturalKey,
  type PullRequestState,
} from './pull-request.ts';
import { githubRepositoryId } from './repository.ts';

/** Красный CI основной ветки: одна строка на проект репозитория. */
export const STALL_LINE_DEFAULT_BRANCH = 'default_branch_ci';

/** Открытый PR без движения: одна строка на проект, где автор — участник. */
export const STALL_LINE_PULL_REQUEST = 'pull_request';

/**
 * Дата ключа `repo.pr_stalled`.
 * Событие про pull request, не про проект, поэтому сутки ключа — UTC.
 * Порог строки считается по таймзоне проекта.
 */
export const PR_STALL_NOTICE_ZONE = 'UTC';

export const PR_STALL_ACTOR_ID = 'system';

export const PR_STALL_ACTOR_ROLE = 'system';

export const PR_STALL_SOURCE = 'system';

export const PR_STALL_SUBJECT = 'PullRequest';

/** Репозиторий зеркала: CI основной ветки пуст, пока workflow не завершился. */
export interface StallRepository {
  repositoryId: string;
  defaultBranchCi: CiStatus | null;
}

/** Проект в момент показа. Пустой `repositoryId` — репозиторий не подключён. */
export interface StallProject {
  projectId: string;
  repositoryId: string | null;
  timezone: string;
}

/** Участник в момент показа. Логин сопоставляется сейчас. */
export interface StallMember {
  projectId: string;
  githubLogin: string | null;
}

/** Pull request зеркала. Проекта и задачи в строке нет. */
export interface StallPullRequest {
  id: string;
  repositoryId: string;
  pullRequestNumber: number;
  authorLogin: string;
  state: string;
  ciStatus: CiStatus | null;
  updatedAt: Date;
}

export interface StallInput {
  now: Date;
  repositories: readonly StallRepository[];
  projects: readonly StallProject[];
  members: readonly StallMember[];
  pullRequests: readonly StallPullRequest[];
}

/** Строка красного CI основной ветки. Номера задачи нет. */
export interface DefaultBranchStallLine {
  kind: typeof STALL_LINE_DEFAULT_BRANCH;
  projectId: string;
  repositoryId: string;
}

/**
 * Строка застрявшего PR.
 * `ciRed` — пометка той же строки, не вторая строка.
 */
export interface PullRequestStallLine {
  kind: typeof STALL_LINE_PULL_REQUEST;
  projectId: string;
  repositoryId: string;
  pullRequestNumber: number;
  authorLogin: string;
  ciRed: boolean;
}

export type StallLine = DefaultBranchStallLine | PullRequestStallLine;

/** Факт A-35: pull request без движения. Ключ — репозиторий, номер и дата. */
export interface PrStallNotice {
  repositoryId: string;
  pullRequestNumber: number;
  pullRequestId: string;
  authorLogin: string;
  days: number;
  date: string;
  idempotencyKey: string;
}

export interface StallFacts {
  lines: StallLine[];
  notices: PrStallNotice[];
}

export interface PrStallStore {
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
}

/** Ключ `repo.pr_stalled`: репозиторий, номер PR и дата. Повтор в те же сутки не пишет второй факт. */
export function prStalledKey(repositoryId: string, pullRequestNumber: number, date: string): string {
  const key = pullRequestNaturalKey(repositoryId, pullRequestNumber);
  return `${EVENT_TYPES.REPO_PR_STALLED}+${key.repositoryId}+${String(key.pullRequestNumber)}+${date}`;
}

function ciIsRed(status: CiStatus | null): boolean {
  return status === CI_STATUS_FAILURE;
}

function pullRequestStateOf(value: string): PullRequestState {
  const state = value.trim();
  for (const item of PULL_REQUEST_STATES) {
    if (item === state) return item;
  }
  throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_STATE, 'Состояние pull request — open, closed или merged');
}

function moment(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_UPDATED_AT, 'Дата pull request — метка времени');
  }
  return value;
}

function connected(project: StallProject, repositoryId: string): boolean {
  if (project.repositoryId === null) return false;
  return githubRepositoryId(project.repositoryId) === repositoryId;
}

function authorInProject(projectId: string, author: string, members: readonly StallMember[]): boolean {
  for (const member of members) {
    if (member.projectId.trim() !== projectId) continue;
    if (matchesCurrentGithubLogin(member.githubLogin, author)) return true;
  }
  return false;
}

/**
 * Факты застоя репозитория из зеркала.
 * Красный CI основной ветки — строка на каждом подключённом проекте.
 * Открытый PR без движения дольше порога и с автором-участником — одна строка
 * на такой проект. Красный CI этого PR помечает ту же строку.
 * Закрытый PR, чужой логин, неизвестный и некрасный CI строк не дают.
 * Issue и граф связей сюда не входят: из них строка не строится.
 * Задачу факт не называет.
 */
export function repositoryStallFacts(input: StallInput): StallFacts {
  const lines: StallLine[] = [];
  const seenDefault = new Set<string>();
  for (const repository of input.repositories) {
    if (!ciIsRed(repository.defaultBranchCi)) continue;
    const repositoryId = githubRepositoryId(repository.repositoryId);
    for (const project of input.projects) {
      if (!connected(project, repositoryId)) continue;
      const projectId = project.projectId.trim();
      if (projectId.length === 0) continue;
      const key = `${projectId}\n${repositoryId}`;
      if (seenDefault.has(key)) continue;
      seenDefault.add(key);
      lines.push({ kind: STALL_LINE_DEFAULT_BRANCH, projectId, repositoryId });
    }
  }

  const notices: PrStallNotice[] = [];
  const seenPr = new Set<string>();
  const date = projectCalendarDate(input.now, PR_STALL_NOTICE_ZONE);
  for (const pullRequest of input.pullRequests) {
    const natural = pullRequestNaturalKey(pullRequest.repositoryId, pullRequest.pullRequestNumber);
    const prKey = `${natural.repositoryId}\n${String(natural.pullRequestNumber)}`;
    if (seenPr.has(prKey)) continue;
    seenPr.add(prKey);
    if (pullRequestStateOf(pullRequest.state) !== PULL_REQUEST_STATE_OPEN) continue;
    const author = normalizeGithubLogin(pullRequest.authorLogin);
    if (author === null) continue;
    const updatedAt = moment(pullRequest.updatedAt);
    const seenProject = new Set<string>();
    let stalled = false;
    let stalledDays = 0;
    for (const project of input.projects) {
      if (!connected(project, natural.repositoryId)) continue;
      const projectId = project.projectId.trim();
      if (projectId.length === 0 || seenProject.has(projectId)) continue;
      seenProject.add(projectId);
      if (!authorInProject(projectId, author, input.members)) continue;
      if (!staleByProjectZone(updatedAt, input.now, project.timezone)) continue;
      const idle = projectDaysBetween(updatedAt, input.now, project.timezone);
      if (!stalled || idle > stalledDays) stalledDays = idle;
      stalled = true;
      lines.push({
        kind: STALL_LINE_PULL_REQUEST,
        projectId,
        repositoryId: natural.repositoryId,
        pullRequestNumber: natural.pullRequestNumber,
        authorLogin: author,
        ciRed: ciIsRed(pullRequest.ciStatus),
      });
    }
    if (!stalled) continue;
    if (!Number.isInteger(stalledDays)) {
      throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_UPDATED_AT, 'срок без движения PR');
    }
    const pullRequestId = pullRequest.id.trim();
    if (pullRequestId.length === 0) {
      throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_ID_BLANK, 'У pull request есть id');
    }
    notices.push({
      repositoryId: natural.repositoryId,
      pullRequestNumber: natural.pullRequestNumber,
      pullRequestId,
      authorLogin: author,
      days: stalledDays,
      date,
      idempotencyKey: prStalledKey(natural.repositoryId, natural.pullRequestNumber, date),
    });
  }
  return { lines, notices };
}

/**
 * Записать `repo.pr_stalled`. Повтор ключа второе событие не пишет.
 * Задачи и блокеры этот акт не меняет.
 */
export async function publishPrStalled(
  store: PrStallStore,
  journal: EventJournal,
  input: PrStallNotice & { occurredAt: Date },
): Promise<{ applied: boolean; eventId: string }> {
  const prior = await store.seen(input.idempotencyKey);
  if (prior !== null) return { applied: false, eventId: prior.eventId };
  const published = await emit(journal, {
    type: EVENT_TYPES.REPO_PR_STALLED,
    source: PR_STALL_SOURCE,
    idempotencyKey: input.idempotencyKey,
    payload: {
      repository_id: input.repositoryId,
      pull_request_number: input.pullRequestNumber,
      author_login: input.authorLogin,
      days: input.days,
    },
    actor: { id: PR_STALL_ACTOR_ID, role: PR_STALL_ACTOR_ROLE },
    subject: { entity: PR_STALL_SUBJECT, id: input.pullRequestId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  return { applied: true, eventId: published.row.id };
}
