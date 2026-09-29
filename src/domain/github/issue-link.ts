import type { PayloadByType } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { githubRepositoryId } from './repository.ts';
import {
  ISSUE_LINK_REMOVED,
  defineIssueDependency,
  issueLinkAction,
  issueLinkType,
  type IssueDependency,
} from './issue-dependency.ts';

/** Порт зеркала связи внутри уже открытой транзакции. */
export interface IssueLinkStore {
  findIssueId(repositoryId: string, issueNumber: number): Promise<string | null>;
  add(link: IssueDependency): Promise<void>;
  remove(link: IssueDependency): Promise<void>;
}

function githubIssueNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'Номер issue — положительное число GitHub');
  }
  return value;
}

/**
 * Кладёт или снимает связь в зеркале репозитория.
 * Строка пишется, когда оба issue уже есть в зеркале. Чужой репозиторий в факт не входит.
 * Повтор той же тройки не создаёт второй строки.
 * Очередь плана задач эту связь не читает.
 */
export async function mirrorIssueLink(
  store: IssueLinkStore,
  fact: PayloadByType['github.issue_links_changed'],
): Promise<boolean> {
  const repositoryId = githubRepositoryId(fact.repository_id);
  const issueNumber = githubIssueNumber(fact.issue_number);
  const dependsOnIssueNumber = githubIssueNumber(fact.depends_on_issue_number);
  if (issueNumber === dependsOnIssueNumber) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_SELF, 'issue не зависит от себя');
  }
  const issueId = await store.findIssueId(repositoryId, issueNumber);
  const dependsOnIssueId = await store.findIssueId(repositoryId, dependsOnIssueNumber);
  if (issueId === null || dependsOnIssueId === null) return false;
  const link = defineIssueDependency({
    issueId,
    dependsOnIssueId,
    linkType: issueLinkType(fact.link_type),
  });
  if (issueLinkAction(fact.action) === ISSUE_LINK_REMOVED) {
    await store.remove(link);
    return true;
  }
  await store.add(link);
  return true;
}
