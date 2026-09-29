import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_OPEN,
  backlogShare,
  type BacklogIssue,
  type BacklogShare,
} from './backlog-share.ts';

/** Issue на границе периода. Состояние — то же, что у формулы доли. */
export const PERIOD_FACT_ISSUE = 'issue';

/** Задача периода. В строки бэклога не входит. */
export const PERIOD_FACT_TASK = 'task';

/**
 * Issue на начало и конец периода.
 * `null` на начале — issue ещё не было. `null` на конце — issue уже нет.
 * Хотя бы одна граница задана.
 */
export interface PeriodIssueFact {
  kind: typeof PERIOD_FACT_ISSUE;
  key: string;
  number: number;
  title: string;
  atStart: BacklogIssue | null;
  atEnd: BacklogIssue | null;
}

/** Закрытая или любая другая задача. Строки бэклога её не читают. */
export interface PeriodTaskFact {
  kind: typeof PERIOD_FACT_TASK;
  title: string;
  status: string;
}

/** Факты периода. Строки бэклога считаются из issues, задачи пропускаются. */
export type PeriodFact = PeriodIssueFact | PeriodTaskFact;

/** Issue в строке «Закрыто» или «Открыто новых». */
export interface PeriodIssueLine {
  key: string;
  number: number;
  title: string;
}

/**
 * Остаток на конец периода.
 * `total` — открытые и `completed`. `not_planned` в это число не входит.
 * Пустой знаменатель — остатка нет, это не ноль.
 */
export interface PeriodRemainder {
  remaining: number;
  total: number;
}

/**
 * Бэклог отчёта за период.
 * Это не канвас: доля на две границы, остаток только на конец,
 * «Закрыто» и «Открыто новых» — движение issues за период.
 */
export interface PeriodBacklog {
  shareAtStart: BacklogShare;
  shareAtEnd: BacklogShare;
  remainderAtEnd: PeriodRemainder | null;
  closed: PeriodIssueLine[];
  openedNew: PeriodIssueLine[];
}

function issueKey(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.ISSUE_ID_BLANK, 'У issue есть id');
  return key;
}

function issueNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'Номер issue — целое больше нуля');
  }
  return value;
}

function issueTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new DomainError(DOMAIN_ERROR.ISSUE_TITLE_BLANK, 'У issue есть название');
  return title;
}

function completed(issue: BacklogIssue): boolean {
  const reason = issue.stateReason;
  return issue.state.trim() === BACKLOG_ISSUE_CLOSED && reason !== null && reason.trim() === BACKLOG_ISSUE_COMPLETED;
}

function stillOpen(issue: BacklogIssue): boolean {
  return issue.state.trim() === BACKLOG_ISSUE_OPEN;
}

function byNumber(left: PeriodIssueLine, right: PeriodIssueLine): number {
  if (left.number !== right.number) return left.number - right.number;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function lineOf(issue: PeriodIssueFact): PeriodIssueLine {
  return { key: issue.key, number: issue.number, title: issue.title };
}

/**
 * Строки бэклога за период.
 * Доля на начало и на конец и остаток на конец — формула раздела 4.
 * «Закрыто» — issues, которых не было `completed` на начало и которые `completed` на конец.
 * «Открыто новых» — issues, которых не было на начало и которые открыты на конец.
 * `not_planned` в эти строки не входит. Задачи не входят. Повтор тех же фактов даёт тот же отчёт.
 */
export function periodBacklog(facts: readonly PeriodFact[]): PeriodBacklog {
  const issues: PeriodIssueFact[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.kind === PERIOD_FACT_TASK) continue;
    const key = issueKey(fact.key);
    if (seen.has(key)) {
      throw new DomainError(DOMAIN_ERROR.PERIOD_ISSUE_DUPLICATE, 'Issue периода встречается один раз');
    }
    seen.add(key);
    if (fact.atStart === null && fact.atEnd === null) {
      throw new DomainError(DOMAIN_ERROR.PERIOD_ISSUE_SPAN, 'Issue периода стоит на начало или на конец');
    }
    issues.push({
      kind: PERIOD_FACT_ISSUE,
      key,
      number: issueNumber(fact.number),
      title: issueTitle(fact.title),
      atStart: fact.atStart,
      atEnd: fact.atEnd,
    });
  }

  const shareAtStart = backlogShare(issues.flatMap((issue) => (issue.atStart === null ? [] : [issue.atStart])));
  const shareAtEnd = backlogShare(issues.flatMap((issue) => (issue.atEnd === null ? [] : [issue.atEnd])));

  const closed: PeriodIssueLine[] = [];
  const openedNew: PeriodIssueLine[] = [];
  for (const issue of issues) {
    const end = issue.atEnd;
    if (end !== null && completed(end) && (issue.atStart === null || !completed(issue.atStart))) {
      closed.push(lineOf(issue));
    }
    if (issue.atStart === null && end !== null && stillOpen(end)) {
      openedNew.push(lineOf(issue));
    }
  }
  closed.sort(byNumber);
  openedNew.sort(byNumber);

  return {
    shareAtStart,
    shareAtEnd,
    remainderAtEnd:
      shareAtEnd.ratio === null
        ? null
        : { remaining: shareAtEnd.remaining, total: shareAtEnd.remaining + shareAtEnd.completed },
    closed,
    openedNew,
  };
}
