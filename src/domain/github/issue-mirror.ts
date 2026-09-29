import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineIssue, ISSUE_STATE_CLOSED, issueNaturalKey, type Issue } from './issue.ts';

/** Порт зеркала issue внутри уже открытой транзакции. */
export interface IssueMirrorStore {
  find(repositoryId: string, issueNumber: number): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
}

/**
 * Снимок issue для зеркала репозитория.
 * Проекта в снимке нет: два проекта одного репозитория делят одну строку.
 */
export interface IssueMirrorFact {
  id: string;
  repositoryId: string;
  issueNumber: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedByLogin: string | null;
  updatedAt: string;
}

/**
 * Пишет issue в зеркало по природному ключу.
 * Повтор того же репозитория и номера обновляет ту же строку и сохраняет её id.
 * Дата закрытия ставится при первом закрытии и не сдвигается правкой названия.
 */
export async function saveIssueMirror(store: IssueMirrorStore, fact: IssueMirrorFact): Promise<Issue> {
  const key = issueNaturalKey(fact.repositoryId, fact.issueNumber);
  const existing = await store.find(key.repositoryId, key.issueNumber);
  const closing = fact.state.trim() === ISSUE_STATE_CLOSED;
  let closedAt: string | null = null;
  if (closing) {
    closedAt =
      existing !== null && existing.state === ISSUE_STATE_CLOSED && existing.closedAt !== null
        ? existing.closedAt
        : fact.updatedAt;
  }
  const issue = defineIssue({
    id: existing === null ? fact.id : existing.id,
    repositoryId: key.repositoryId,
    issueNumber: key.issueNumber,
    title: fact.title,
    state: fact.state,
    stateReason: fact.stateReason,
    closedByLogin: fact.closedByLogin,
    updatedAt: fact.updatedAt,
    closedAt,
  });
  await store.save(issue);
  const stored = await store.find(issue.repositoryId, issue.issueNumber);
  if (stored === null) throw new DomainError(DOMAIN_ERROR.ISSUE_MIRROR, 'issue не записан в зеркало');
  return stored;
}
