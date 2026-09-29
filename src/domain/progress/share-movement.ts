import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { backlogShare, type BacklogIssue, type BacklogShare } from './backlog-share.ts';

/** «Сделано» — список issues репозитория. */
export const BACKLOG_LIST_DONE = 'done';

/** «В работе» — список issues репозитория. */
export const BACKLOG_LIST_IN_PROGRESS = 'in_progress';

/** «Далее» — список issues репозитория. */
export const BACKLOG_LIST_NEXT = 'next';

/** Списки канваса, которые читают тот же список issues, что и процент. */
export const REPOSITORY_BACKLOG_LISTS = [BACKLOG_LIST_DONE, BACKLOG_LIST_IN_PROGRESS, BACKLOG_LIST_NEXT] as const;

export type RepositoryBacklogList = (typeof REPOSITORY_BACKLOG_LISTS)[number];

/**
 * Issue репозитория, из которого считаются процент и списки.
 * Несколько assignees не размножают issue: в процент он входит один раз.
 * Назначение людей процент не делит.
 */
export interface RepositoryIssue extends BacklogIssue {
  key: string;
  assignees: readonly string[];
}

/** Задача дня. Учёт дня, не строка процента. */
export interface DayAccount {
  status: string;
  checked: boolean;
  priority: string;
}

export const SHARE_FACT_DAY_TASK = 'day_task';

export const SHARE_FACT_TASK_CLOSED = 'task_closed';

export const SHARE_FACT_CHECKMARK = 'checkmark';

export const SHARE_FACT_MERGED_PULL_REQUEST = 'pull_request_merged';

/** Коммит репозитория. В долю бэклога не входит. */
export const SHARE_FACT_COMMIT = 'commit';

export const SHARE_FACT_TASK_PRIORITY = 'task_priority';

export const SHARE_FACT_ISSUE_STATE = 'issue_state';

/** Факт рядом с долей. В формулу проходит только смена состояния issue. */
export type ShareFact =
  | { kind: typeof SHARE_FACT_DAY_TASK; status: string; checked: boolean; priority: string }
  | { kind: typeof SHARE_FACT_TASK_CLOSED }
  | { kind: typeof SHARE_FACT_CHECKMARK }
  | { kind: typeof SHARE_FACT_MERGED_PULL_REQUEST }
  | { kind: typeof SHARE_FACT_COMMIT }
  | { kind: typeof SHARE_FACT_TASK_PRIORITY; priority: string }
  | {
      kind: typeof SHARE_FACT_ISSUE_STATE;
      key: string;
      state: string;
      stateReason: string | null;
    };

/** Процент и три списка читают один и тот же список issues репозитория. */
export interface RepositoryBacklog {
  share: BacklogShare;
  issues: readonly RepositoryIssue[];
  lists: readonly [typeof BACKLOG_LIST_DONE, typeof BACKLOG_LIST_IN_PROGRESS, typeof BACKLOG_LIST_NEXT];
}

function issueKey(value: string): string {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_ID_BLANK, 'У issue есть id');
  }
  return key;
}

/**
 * Один issue — одна строка формулы, даже если assignees несколько.
 * Повтор ключа (разворот по людям) не считается второй раз.
 */
function issuesOnce(issues: readonly RepositoryIssue[]): RepositoryIssue[] {
  const seen = new Set<string>();
  const unique: RepositoryIssue[] = [];
  for (const issue of issues) {
    const key = issueKey(issue.key);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      key,
      state: issue.state,
      stateReason: issue.stateReason,
      assignees: [...issue.assignees],
    });
  }
  return unique;
}

/**
 * Процент проекта — одна доля на список issues.
 * По людям не делится: assignees в формулу не входят.
 */
export function projectShare(issues: readonly RepositoryIssue[]): BacklogShare {
  return backlogShare(issuesOnce(issues));
}

/**
 * Процент и списки «Сделано / В работе / Далее» — issues репозитория.
 * Задачи дня в этот список не подставляются.
 */
export function repositoryBacklog(issues: readonly RepositoryIssue[]): RepositoryBacklog {
  const once = issuesOnce(issues);
  return {
    share: backlogShare(once),
    issues: once,
    lists: REPOSITORY_BACKLOG_LISTS,
  };
}

/** Задача дня в списки issues репозитория не встаёт. */
export function listedFromDay(account: DayAccount): false {
  void account.status;
  void account.checked;
  void account.priority;
  return false;
}

/** Issue репозитория — источник списков и процента. */
export function listedFromRepository(issue: RepositoryIssue): true {
  void issue.key;
  return true;
}

/** Задачи остаются учётом дня: из фактов дня собирается дневной учёт, не доля. */
export function dayAccounts(facts: readonly ShareFact[]): DayAccount[] {
  const accounts: DayAccount[] = [];
  for (const fact of facts) {
    if (fact.kind !== SHARE_FACT_DAY_TASK) continue;
    accounts.push({ status: fact.status, checked: fact.checked, priority: fact.priority });
  }
  return accounts;
}

function applyIssueState(issues: RepositoryIssue[], fact: Extract<ShareFact, { kind: typeof SHARE_FACT_ISSUE_STATE }>): void {
  const key = issueKey(fact.key);
  for (const issue of issues) {
    if (issue.key !== key) continue;
    issue.state = fact.state;
    issue.stateReason = fact.stateReason;
  }
}

/**
 * Долю двигает смена состояния issue.
 * Закрытая задача, галочка, приоритет, учёт дня, смерженный PR и коммит формулу не меняют.
 */
export function shareAfter(issues: readonly RepositoryIssue[], facts: readonly ShareFact[]): BacklogShare {
  const current = issuesOnce(issues);
  for (const fact of facts) {
    switch (fact.kind) {
      case SHARE_FACT_ISSUE_STATE:
        applyIssueState(current, fact);
        break;
      case SHARE_FACT_DAY_TASK:
      case SHARE_FACT_TASK_CLOSED:
      case SHARE_FACT_CHECKMARK:
      case SHARE_FACT_MERGED_PULL_REQUEST:
      case SHARE_FACT_COMMIT:
      case SHARE_FACT_TASK_PRIORITY:
        break;
      default: {
        const unreachable: never = fact;
        return unreachable;
      }
    }
  }
  return backlogShare(current);
}
