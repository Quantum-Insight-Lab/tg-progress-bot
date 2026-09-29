import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Issue заблокирован другим issue. */
export const ISSUE_LINK_BLOCKED_BY = 'blocked_by';

/** У issue есть sub-issue. */
export const ISSUE_LINK_SUB_ISSUE = 'sub_issue';

/** Виды связи issues. Другого нет. */
export const ISSUE_LINK_TYPES = [ISSUE_LINK_BLOCKED_BY, ISSUE_LINK_SUB_ISSUE] as const;

export type IssueLinkType = (typeof ISSUE_LINK_TYPES)[number];

/** Связь появилась. */
export const ISSUE_LINK_ADDED = 'added';

/** Связь снята. */
export const ISSUE_LINK_REMOVED = 'removed';

/** Что произошло со связью. */
export const ISSUE_LINK_ACTIONS = [ISSUE_LINK_ADDED, ISSUE_LINK_REMOVED] as const;

export type IssueLinkAction = (typeof ISSUE_LINK_ACTIONS)[number];

/**
 * Связь issues (E-12).
 * `blocked_by`: issue заблокирован `dependsOnIssueId`.
 * `sub_issue`: `dependsOnIssueId` — подзадача этого issue.
 * Ключ — пара issues и вид связи. Проекта нет.
 */
export interface IssueDependency {
  issueId: string;
  dependsOnIssueId: string;
  linkType: IssueLinkType;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

/** Вид связи: `blocked_by` или `sub_issue`. */
export function issueLinkType(value: string): IssueLinkType {
  const linkType = oneOf(value, ISSUE_LINK_TYPES);
  if (linkType !== undefined) return linkType;
  throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_TYPE, 'связь — blocked_by или sub_issue');
}

/** Связь либо добавляется, либо снимается. */
export function issueLinkAction(value: string): IssueLinkAction {
  const action = oneOf(value, ISSUE_LINK_ACTIONS);
  if (action !== undefined) return action;
  throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_ACTION, 'связь добавляется или снимается');
}

/** Поля связи. Issue не ссылается на себя. */
export function defineIssueDependency(input: {
  issueId: string;
  dependsOnIssueId: string;
  linkType: string;
}): IssueDependency {
  const issueId = input.issueId.trim();
  const dependsOnIssueId = input.dependsOnIssueId.trim();
  if (issueId.length === 0 || dependsOnIssueId.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_ISSUE, 'у связи есть оба issue');
  }
  if (issueId === dependsOnIssueId) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_SELF, 'issue не зависит от себя');
  }
  return { issueId, dependsOnIssueId, linkType: issueLinkType(input.linkType) };
}
