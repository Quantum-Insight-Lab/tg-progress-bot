import { EVENT_TYPES, emit, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import { projectCalendarDate } from '../shared/project-time.ts';

/**
 * Сигнал расхождения (INV-15).
 * Проектный, за календарные сутки его таймзоны.
 * Горит, когда за эти сутки участник двигал репозиторий,
 * а в задачах проекта тишина: ни одной новой и ни одного перехода в DONE.
 * Красный CI движением не считается. Статусы и блокеры эта функция не меняет.
 * Акт пишет факт, когда эти сутки уже закрылись: день ещё идёт — сигнал рано фиксировать.
 */

/** Сигнал пишет система (A-36). */
export const DIVERGENCE_ACTOR_ID = 'system';

export const DIVERGENCE_ACTOR_ROLE = 'system';

export const DIVERGENCE_SOURCE = 'system';

export const DIVERGENCE_SUBJECT = 'Project';

const YEAR = /^\d{4}$/;

const MONTH_OR_DAY = /^\d{2}$/;

/** Длины месяцев. Февраль в невисокосном году; високосный добавляет один день. */
const MONTH_LENGTHS = ['31', '28', '31', '30', '31', '30', '31', '31', '30', '31', '30', '31'];

const PULL_REQUEST_OPEN = 'open';

const PULL_REQUEST_CLOSED = 'closed';

const PULL_REQUEST_MERGED = 'merged';

const ISSUE_OPEN = 'open';

const ISSUE_CLOSED = 'closed';

/** Проект в момент сигнала. Пустой репозиторий — движение взять неоткуда. */
export interface DivergenceProject {
  projectId: string;
  timezone: string;
  repositoryId: string | null;
}

/** Участник в момент сигнала. Логин сопоставляется сейчас. */
export interface DivergenceMember {
  projectId: string;
  githubLogin: string | null;
}

/** Коммит хвоста. Действующее лицо — автор. */
export interface DivergenceCommit {
  repositoryId: string;
  authorLogin: string;
  createdAt: Date;
}

/**
 * Pull request зеркала.
 * В движение входит только смерженный, и только автор, не тот, кто нажал merge.
 */
export interface DivergencePullRequest {
  repositoryId: string;
  state: string;
  authorLogin: string;
  mergedAt: Date | null;
}

/** Issue зеркала. В движение входит закрытый; действующее лицо — кто закрыл. */
export interface DivergenceIssue {
  repositoryId: string;
  state: string;
  closedByLogin: string | null;
  closedAt: Date | null;
}

/**
 * Задача проекта.
 * Тишину ломает создание в эти сутки или переход в DONE в эти сутки.
 * Уже идущая задача без этих двух фактов тишину не ломает.
 */
export interface DivergenceTask {
  projectId: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface DivergenceFacts {
  now: Date;
  projects: readonly DivergenceProject[];
  members: readonly DivergenceMember[];
  commits: readonly DivergenceCommit[];
  pullRequests: readonly DivergencePullRequest[];
  issues: readonly DivergenceIssue[];
  tasks: readonly DivergenceTask[];
  takenKeys: ReadonlySet<string>;
}

/** Факт A-36: сутки проекта закрылись расхождением. */
export interface DivergenceNotice {
  projectId: string;
  date: string;
  idempotencyKey: string;
}

export interface DivergenceStore {
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
}

function projectIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new DomainError(DOMAIN_ERROR.PROJECT_ID_BLANK, 'У проекта есть id');
  return id;
}

function divides(year: number, by: string): boolean {
  const divisor = Number(by);
  if (divisor === 0) return false;
  return year % divisor === 0;
}

function leapYear(year: number): boolean {
  if (!divides(year, '4')) return false;
  if (!divides(year, '100')) return true;
  return divides(year, '400');
}

function monthLength(year: number, month: number): number {
  const february = Number('2');
  const lastMonth = Number('12');
  if (month < 1 || month > lastMonth) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата сигнала — календарный день');
  }
  const stored = MONTH_LENGTHS[month - 1];
  const base = stored === undefined ? Number.NaN : Number(stored);
  if (!Number.isInteger(base) || base < 1) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата сигнала — календарный день');
  }
  if (month !== february) return base;
  return leapYear(year) ? base + 1 : base;
}

function isoDate(year: number, month: number, day: number): string {
  const monthText = String(month).padStart(1 + 1, '0');
  const dayText = String(day).padStart(1 + 1, '0');
  return `${String(year)}-${monthText}-${dayText}`;
}

function calendarParts(value: string): { year: number; month: number; day: number } {
  const pieces = value.trim().split('-');
  const yearText = pieces[0];
  const monthText = pieces[1];
  const dayText = pieces[1 + 1];
  if (
    pieces.length !== 1 + 1 + 1 ||
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    !YEAR.test(yearText) ||
    !MONTH_OR_DAY.test(monthText) ||
    !MONTH_OR_DAY.test(dayText)
  ) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата сигнала — календарный день');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (day < 1 || day > monthLength(year, month)) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата сигнала — календарный день');
  }
  return { year, month, day };
}

/** Предыдущий календарный день. Сутки сигнала — уже закрытые. */
export function previousCalendarDate(iso: string): string {
  const { year, month, day } = calendarParts(iso);
  if (day > 1) return isoDate(year, month, day - 1);
  if (month > 1) {
    const previousMonth = month - 1;
    return isoDate(year, previousMonth, monthLength(year, previousMonth));
  }
  const december = Number('12');
  return isoDate(year - 1, december, monthLength(year - 1, december));
}

/** Последние закрытые сутки проекта. Текущий день ещё не закрыт. */
export function closedProjectDate(now: Date, timezone: string): string {
  if (Number.isNaN(now.getTime())) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата сигнала — метка времени');
  }
  return previousCalendarDate(projectCalendarDate(now, timezone));
}

/**
 * Сутки строки расхождения на канвасе: день перед датой канваса.
 * Текущие сутки ещё идут, сигнал по ним рано показывать.
 */
export function canvasDivergenceDate(canvasDate: string): string {
  return previousCalendarDate(canvasDate);
}

/** Ключ `divergence.detected`: проект и дата. Повтор в те же сутки не пишет второй факт. */
export function divergenceDetectedKey(projectId: string, date: string): string {
  const id = projectIdOf(projectId);
  const { year, month, day } = calendarParts(date);
  return `${EVENT_TYPES.DIVERGENCE_DETECTED}+${id}+${isoDate(year, month, day)}`;
}

function moment(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'Дата факта — метка времени');
  }
  return value;
}

function onDate(value: Date, timezone: string, date: string): boolean {
  return projectCalendarDate(moment(value), timezone) === date;
}

function memberMoved(projectId: string, login: string | null, members: readonly DivergenceMember[]): boolean {
  const actor = normalizeGithubLogin(login);
  if (actor === null) return false;
  for (const member of members) {
    if (member.projectId.trim() !== projectId) continue;
    if (matchesCurrentGithubLogin(member.githubLogin, actor)) return true;
  }
  return false;
}

function pullRequestState(value: string): string {
  const state = value.trim();
  if (state === PULL_REQUEST_OPEN || state === PULL_REQUEST_CLOSED || state === PULL_REQUEST_MERGED) return state;
  throw new DomainError(DOMAIN_ERROR.DIVERGENCE_FACT, 'Состояние pull request — open, closed или merged');
}

function issueState(value: string): string {
  const state = value.trim();
  if (state === ISSUE_OPEN || state === ISSUE_CLOSED) return state;
  throw new DomainError(DOMAIN_ERROR.DIVERGENCE_FACT, 'Состояние issue — open или closed');
}

function repositoryMoved(
  projectId: string,
  repositoryId: string,
  timezone: string,
  date: string,
  members: readonly DivergenceMember[],
  commits: readonly DivergenceCommit[],
  pullRequests: readonly DivergencePullRequest[],
  issues: readonly DivergenceIssue[],
): boolean {
  for (const commit of commits) {
    if (commit.repositoryId.trim() !== repositoryId) continue;
    if (!onDate(commit.createdAt, timezone, date)) continue;
    if (memberMoved(projectId, commit.authorLogin, members)) return true;
  }
  for (const pullRequest of pullRequests) {
    if (pullRequest.repositoryId.trim() !== repositoryId) continue;
    if (pullRequestState(pullRequest.state) !== PULL_REQUEST_MERGED) continue;
    if (pullRequest.mergedAt === null) continue;
    if (!onDate(pullRequest.mergedAt, timezone, date)) continue;
    if (memberMoved(projectId, pullRequest.authorLogin, members)) return true;
  }
  for (const issue of issues) {
    if (issue.repositoryId.trim() !== repositoryId) continue;
    if (issueState(issue.state) !== ISSUE_CLOSED) continue;
    if (issue.closedAt === null) continue;
    if (!onDate(issue.closedAt, timezone, date)) continue;
    if (memberMoved(projectId, issue.closedByLogin, members)) return true;
  }
  return false;
}

function tasksSilent(
  projectId: string,
  timezone: string,
  date: string,
  tasks: readonly DivergenceTask[],
): boolean {
  for (const task of tasks) {
    if (task.projectId.trim() !== projectId) continue;
    if (onDate(task.createdAt, timezone, date)) return false;
    if (task.completedAt !== null && onDate(task.completedAt, timezone, date)) return false;
  }
  return true;
}

/**
 * Сигнал одного проекта за указанные сутки.
 * Обе половины сразу: движение участника в репозитории и тишина в задачах.
 * Чужой логин, другой репозиторий и красный CI сюда не входят.
 */
export function projectDiverges(input: {
  project: DivergenceProject;
  date: string;
  members: readonly DivergenceMember[];
  commits: readonly DivergenceCommit[];
  pullRequests: readonly DivergencePullRequest[];
  issues: readonly DivergenceIssue[];
  tasks: readonly DivergenceTask[];
}): boolean {
  const projectId = projectIdOf(input.project.projectId);
  const { year, month, day } = calendarParts(input.date);
  const date = isoDate(year, month, day);
  const repositoryId = input.project.repositoryId?.trim() ?? '';
  if (repositoryId.length === 0) return false;
  const moved = repositoryMoved(
    projectId,
    repositoryId,
    input.project.timezone,
    date,
    input.members,
    input.commits,
    input.pullRequests,
    input.issues,
  );
  if (!moved) return false;
  return tasksSilent(projectId, input.project.timezone, date, input.tasks);
}

/**
 * Сигналы по последним закрытым суткам каждого проекта.
 * Уже записанный ключ повторно не входит. Текущий, ещё открытый день не входит.
 */
export function dueDivergence(facts: DivergenceFacts): DivergenceNotice[] {
  const seen = new Set<string>();
  const notices: DivergenceNotice[] = [];
  for (const project of facts.projects) {
    const projectId = projectIdOf(project.projectId);
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    const date = closedProjectDate(facts.now, project.timezone);
    const idempotencyKey = divergenceDetectedKey(projectId, date);
    if (facts.takenKeys.has(idempotencyKey)) continue;
    const lit = projectDiverges({
      project: { ...project, projectId },
      date,
      members: facts.members,
      commits: facts.commits,
      pullRequests: facts.pullRequests,
      issues: facts.issues,
      tasks: facts.tasks,
    });
    if (!lit) continue;
    notices.push({ projectId, date, idempotencyKey });
  }
  return notices;
}

/**
 * Записать `divergence.detected`. Повтор ключа второе событие не пишет.
 * Задачи и блокеры этот акт не меняет.
 */
export async function publishDivergenceDetected(
  store: DivergenceStore,
  journal: EventJournal,
  input: DivergenceNotice & { occurredAt: Date },
): Promise<{ applied: boolean; eventId: string }> {
  const projectId = projectIdOf(input.projectId);
  const { year, month, day } = calendarParts(input.date);
  const date = isoDate(year, month, day);
  const idempotencyKey = divergenceDetectedKey(projectId, date);
  if (input.idempotencyKey !== idempotencyKey) {
    throw new DomainError(DOMAIN_ERROR.DIVERGENCE_DATE, 'ключ сигнала — проект и дата');
  }
  const prior = await store.seen(idempotencyKey);
  if (prior !== null) return { applied: false, eventId: prior.eventId };
  const published = await emit(journal, {
    type: EVENT_TYPES.DIVERGENCE_DETECTED,
    source: DIVERGENCE_SOURCE,
    idempotencyKey,
    payload: { project_id: projectId, date },
    actor: { id: DIVERGENCE_ACTOR_ID, role: DIVERGENCE_ACTOR_ROLE },
    subject: { entity: DIVERGENCE_SUBJECT, id: projectId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  return { applied: true, eventId: published.row.id };
}
