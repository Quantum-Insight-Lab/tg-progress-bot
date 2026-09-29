import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * Слова состояния — те же, что у issue зеркала (E-10).
 * Контекст progress их повторяет: контексты домена друг друга не импортируют.
 */
export const BACKLOG_ISSUE_OPEN = 'open';

export const BACKLOG_ISSUE_CLOSED = 'closed';

/** Закрыт как сделанный. Только это стоит в числителе. */
export const BACKLOG_ISSUE_COMPLETED = 'completed';

/** Закрыт как не запланированный. В формулу не входит. */
export const BACKLOG_ISSUE_NOT_PLANNED = 'not_planned';

/**
 * Issue, из которого считается доля.
 * Размера работы и назначения здесь нет: каждый issue весит одинаково,
 * открытый входит в знаменатель, кем бы он ни был назначен.
 * Задача дня сюда не подставляется — линейка читает список issues репозитория.
 */
export interface BacklogIssue {
  state: string;
  stateReason: string | null;
}

/**
 * Доля бэклога одного списка issues.
 * `ratio` — дробь `completed / (remaining + completed)`, не процент.
 * Пустой знаменатель — нет числа: делить не на что.
 */
export interface BacklogShare {
  /** Сколько issues уже закрыто как `completed`. Числитель. */
  completed: number;
  /** Сколько ещё осталось: открытые issues. */
  remaining: number;
  /** `completed / (remaining + completed)`. Пустой знаменатель — `null`. */
  ratio: number | null;
}

type IssueState = typeof BACKLOG_ISSUE_OPEN | typeof BACKLOG_ISSUE_CLOSED;

type IssueStateReason = typeof BACKLOG_ISSUE_COMPLETED | typeof BACKLOG_ISSUE_NOT_PLANNED;

function issueState(value: string): IssueState {
  const state = value.trim();
  if (state === BACKLOG_ISSUE_OPEN) return BACKLOG_ISSUE_OPEN;
  if (state === BACKLOG_ISSUE_CLOSED) return BACKLOG_ISSUE_CLOSED;
  throw new DomainError(DOMAIN_ERROR.ISSUE_STATE, 'Состояние issue — open или closed');
}

function issueStateReason(value: string | null): IssueStateReason | null {
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

/** Куда issue встаёт в формуле. `outside` — ни в числитель, ни в знаменатель. */
function place(issue: BacklogIssue): 'completed' | 'remaining' | 'outside' {
  const state = issueState(issue.state);
  const reason = issueStateReason(issue.stateReason);
  if (state === BACKLOG_ISSUE_OPEN) {
    if (reason !== null) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_STATE_REASON, 'У открытого issue причина пуста');
    }
    return 'remaining';
  }
  if (reason === BACKLOG_ISSUE_COMPLETED) return 'completed';
  if (reason === BACKLOG_ISSUE_NOT_PLANNED) return 'outside';
  throw new DomainError(
    DOMAIN_ERROR.ISSUE_STATE_REASON,
    'У закрытого issue причина — completed или not_planned',
  );
}

/**
 * Единственный расчёт доли бэклога.
 * Читает только состояние issues: `completed / (открытые + completed)`.
 * `not_planned` не считается. Вес каждого учтённого issue — один.
 */
export function backlogShare(issues: readonly BacklogIssue[]): BacklogShare {
  let completed = 0;
  let remaining = 0;
  for (const issue of issues) {
    const slot = place(issue);
    if (slot === 'completed') completed += 1;
    if (slot === 'remaining') remaining += 1;
  }
  const denominator = completed + remaining;
  return {
    completed,
    remaining,
    ratio: denominator === 0 ? null : completed / denominator,
  };
}
