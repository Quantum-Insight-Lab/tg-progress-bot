import { REPORT_NEXT_TASKS } from '../../config/constants.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * «Сейчас», «Дальше» и «Риск» отчёта.
 * Считаются из текущих задач, причин блокеров и фактов застоя.
 * Issues, в том числе `not_planned`, и коммиты в эти строки не входят.
 * Повтор тех же фактов даёт тот же набор. Порядок входа его не меняет.
 */

/** Задача на момент отчёта. */
export const REPORT_CURRENT_TASK = 'task';

/** Issue рядом с задачами. В «Сейчас», «Дальше» и «Риск» не входит. */
export const REPORT_CURRENT_ISSUE = 'issue';

/** Коммит рядом с задачами. В эти строки не входит. */
export const REPORT_CURRENT_COMMIT = 'commit';

/** Красный CI основной git-ветки. Одна строка риска, номер задачи не называет. */
export const REPORT_CURRENT_BRANCH_CI = 'branch_ci';

/** Открытый PR без движения. Номер задачи не называет. */
export const REPORT_CURRENT_PULL_REQUEST = 'pull_request';

const STATUS_IN_PROGRESS = 'IN_PROGRESS';
const STATUS_BLOCKED = 'BLOCKED';
const STATUS_PLANNED = 'PLANNED';

const PRIORITY_HIGH = 'high';
const PRIORITY_NORMAL = 'normal';
const PRIORITY_LOW = 'low';

const PRIORITIES = [PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_LOW] as const;

type ReportPriority = (typeof PRIORITIES)[number];

/** Задача, которая может попасть в «Сейчас» или «Дальше». Причина — только у `BLOCKED`. */
export interface ReportCurrentTask {
  kind: typeof REPORT_CURRENT_TASK;
  key: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  createdAt: string;
  day: number;
  assigneeName: string | null;
  reason: string | null;
}

/** Issue. `stateReason` может быть `not_planned`: строка отчёта его не читает. */
export interface ReportCurrentIssue {
  kind: typeof REPORT_CURRENT_ISSUE;
  key: string;
  title: string;
  stateReason: string | null;
}

/** Коммит. Строки задач его не читают. */
export interface ReportCurrentCommit {
  kind: typeof REPORT_CURRENT_COMMIT;
  key: string;
}

/** Красный CI основной ветки уже отобран. Зелёный сюда не кладётся. */
export interface ReportCurrentBranchCi {
  kind: typeof REPORT_CURRENT_BRANCH_CI;
  key: string;
}

/** PR без движения. `ciRed` — пометка той же строки, не вторая. */
export interface ReportCurrentPullRequest {
  kind: typeof REPORT_CURRENT_PULL_REQUEST;
  key: string;
  pullRequestNumber: number;
  ciRed: boolean;
}

export type ReportCurrentFact =
  | ReportCurrentTask
  | ReportCurrentIssue
  | ReportCurrentCommit
  | ReportCurrentBranchCi
  | ReportCurrentPullRequest;

/** Задача строки «Сейчас»: `IN_PROGRESS` или `BLOCKED`. */
export interface ReportNowTask {
  key: string;
  number: number;
  title: string;
  day: number;
  assigneeName: string | null;
}

/** Задача строки «Дальше»: `PLANNED`, не длиннее `REPORT_NEXT_TASKS`. */
export interface ReportNextTask {
  key: string;
  number: number;
  title: string;
}

/** Причина блокера. Текст ответа, без номера задачи. */
export interface ReportRiskReason {
  key: string;
  text: string;
}

/** PR в строке «Риск». Номер задачи к нему не приписан. */
export interface ReportRiskPullRequest {
  key: string;
  pullRequestNumber: number;
  ciRed: boolean;
}

/**
 * Факты трёх строк.
 * «Сейчас» — `IN_PROGRESS` и `BLOCKED`.
 * «Дальше» — до `REPORT_NEXT_TASKS` задач `PLANNED`, сначала больший приоритет, внутри него раньше созданная.
 * «Риск» — причины `BLOCKED` и факты застоя, дословно.
 */
export interface ReportCurrent {
  now: ReportNowTask[];
  next: ReportNextTask[];
  reasons: ReportRiskReason[];
  defaultBranchCiRed: boolean;
  pullRequests: ReportRiskPullRequest[];
}

interface StoredTask extends ReportCurrentTask {
  status: string;
  priority: ReportPriority;
}

function factKey(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.REPORT_WORK_KEY, 'У факта отчёта есть id');
  return key;
}

function claim(seen: Set<string>, key: string): void {
  if (seen.has(key)) throw new DomainError(DOMAIN_ERROR.REPORT_WORK_DUPLICATE, 'Факт отчёта встречается один раз');
  seen.add(key);
}

function taskNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.REPORT_WORK_NUMBER, 'Номер задачи отчёта — целое больше нуля');
  }
  return value;
}

function taskTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new DomainError(DOMAIN_ERROR.REPORT_WORK_TITLE, 'У задачи отчёта есть название');
  return title;
}

function taskStatus(value: string): string {
  const status = value.trim();
  if (status.length === 0) throw new DomainError(DOMAIN_ERROR.REPORT_WORK_STATUS, 'Статус задачи отчёта не пустой');
  return status;
}

function taskPriority(value: string): ReportPriority {
  const priority = value.trim();
  for (const item of PRIORITIES) {
    if (item === priority) return item;
  }
  throw new DomainError(DOMAIN_ERROR.REPORT_WORK_PRIORITY, 'Приоритет задачи отчёта — high, normal или low');
}

function createdAt(value: string): string {
  const at = value.trim();
  if (at.length === 0) throw new DomainError(DOMAIN_ERROR.REPORT_WORK_CREATED, 'У задачи отчёта есть дата создания');
  return at;
}

function taskDay(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.REPORT_WORK_DAY, 'День задачи отчёта — целое больше нуля');
  }
  return value;
}

function assigneeName(value: string | null): string | null {
  if (value === null) return null;
  const name = value.trim();
  if (name.length === 0) return null;
  return name;
}

function pullRequestNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_NUMBER, 'Номер pull request — положительное число GitHub');
  }
  return value;
}

function byNumber(left: { number: number; key: string }, right: { number: number; key: string }): number {
  if (left.number !== right.number) return left.number - right.number;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function priorityFirst(left: ReportPriority, right: ReportPriority): number {
  if (left === right) return 0;
  if (left === PRIORITY_HIGH) return -1;
  if (right === PRIORITY_HIGH) return 1;
  if (left === PRIORITY_NORMAL) return -1;
  return 1;
}

function nextFirst(left: StoredTask, right: StoredTask): number {
  const byPriority = priorityFirst(left.priority, right.priority);
  if (byPriority !== 0) return byPriority;
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  return byNumber(left, right);
}

function blockerReason(status: string, value: string | null): string | null {
  if (status !== STATUS_BLOCKED || value === null) return null;
  const reason = value.trim();
  if (reason.length === 0) return null;
  return reason;
}

function storeTask(fact: ReportCurrentTask): StoredTask {
  return {
    kind: REPORT_CURRENT_TASK,
    key: fact.key,
    number: taskNumber(fact.number),
    title: taskTitle(fact.title),
    status: taskStatus(fact.status),
    priority: taskPriority(fact.priority),
    createdAt: createdAt(fact.createdAt),
    day: taskDay(fact.day),
    assigneeName: assigneeName(fact.assigneeName),
    reason: fact.reason,
  };
}

/**
 * «Сейчас», «Дальше» и «Риск» из фактов.
 * `IN_PROGRESS` и `BLOCKED` — сейчас. `PLANNED` — дальше, не больше `REPORT_NEXT_TASKS`.
 * Причина печатается только у `BLOCKED` и только когда ответ уже есть.
 * Issues и коммиты набор не меняют. Одинаковые факты дают одинаковый набор.
 */
export function reportCurrent(facts: readonly ReportCurrentFact[]): ReportCurrent {
  const tasks: StoredTask[] = [];
  const pullRequests: ReportRiskPullRequest[] = [];
  const seenTasks = new Set<string>();
  const seenIssues = new Set<string>();
  const seenCommits = new Set<string>();
  const seenCi = new Set<string>();
  const seenPullRequests = new Set<string>();
  let defaultBranchCiRed = false;

  for (const fact of facts) {
    if (fact.kind === REPORT_CURRENT_ISSUE || fact.kind === REPORT_CURRENT_COMMIT) {
      const key = factKey(fact.key);
      claim(fact.kind === REPORT_CURRENT_ISSUE ? seenIssues : seenCommits, key);
      continue;
    }
    if (fact.kind === REPORT_CURRENT_BRANCH_CI) {
      claim(seenCi, factKey(fact.key));
      defaultBranchCiRed = true;
      continue;
    }
    if (fact.kind === REPORT_CURRENT_PULL_REQUEST) {
      const key = factKey(fact.key);
      claim(seenPullRequests, key);
      pullRequests.push({
        key,
        pullRequestNumber: pullRequestNumber(fact.pullRequestNumber),
        ciRed: fact.ciRed,
      });
      continue;
    }
    const key = factKey(fact.key);
    claim(seenTasks, key);
    tasks.push(storeTask({ ...fact, key }));
  }

  const now = tasks
    .filter((task) => task.status === STATUS_IN_PROGRESS || task.status === STATUS_BLOCKED)
    .sort(byNumber)
    .map((task) => ({
      key: task.key,
      number: task.number,
      title: task.title,
      day: task.day,
      assigneeName: task.assigneeName,
    }));

  const next = tasks
    .filter((task) => task.status === STATUS_PLANNED)
    .sort(nextFirst)
    .slice(0, REPORT_NEXT_TASKS)
    .map((task) => ({ key: task.key, number: task.number, title: task.title }));

  const reasons: ReportRiskReason[] = [];
  const blocked = tasks.filter((task) => task.status === STATUS_BLOCKED).sort(byNumber);
  for (const task of blocked) {
    const text = blockerReason(task.status, task.reason);
    if (text !== null) reasons.push({ key: task.key, text });
  }

  pullRequests.sort((left, right) => {
    if (left.pullRequestNumber !== right.pullRequestNumber) return left.pullRequestNumber - right.pullRequestNumber;
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return 0;
  });

  return { now, next, reasons, defaultBranchCiRed, pullRequests };
}
