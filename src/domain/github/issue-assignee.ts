import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Логин, назначенный на issue (E-11). Ключ пары — issue и логин. Проекта нет. */
export interface IssueAssignee {
  issueId: string;
  login: string;
}

/** Поля assignee: issue и логин. Пустой логин не записывается. */
export function defineIssueAssignee(input: { issueId: string; login: string }): IssueAssignee {
  const issueId = input.issueId.trim();
  if (issueId.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_ID_BLANK, 'У assignee есть issue');
  }
  const login = input.login.trim();
  if (login.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_ASSIGNEE_LOGIN, 'У assignee есть логин');
  }
  return { issueId, login };
}

/**
 * Текущий набор assignees одного issue.
 * Повтор логина в списке не даёт второй строки: ключ — issue и логин.
 */
export function issueAssigneeSet(issueId: string, logins: readonly string[]): IssueAssignee[] {
  const seen = new Set<string>();
  const assignees: IssueAssignee[] = [];
  for (const login of logins) {
    const assignee = defineIssueAssignee({ issueId, login });
    if (seen.has(assignee.login)) continue;
    seen.add(assignee.login);
    assignees.push(assignee);
  }
  return assignees;
}
