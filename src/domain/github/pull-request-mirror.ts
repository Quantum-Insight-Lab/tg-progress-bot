import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { definePullRequest, pullRequestNaturalKey, type PullRequest } from './pull-request.ts';

/** Порт зеркала pull request внутри уже открытой транзакции. */
export interface PullRequestMirrorStore {
  find(repositoryId: string, pullRequestNumber: number): Promise<PullRequest | null>;
  save(pullRequest: PullRequest): Promise<void>;
}

/**
 * Снимок pull request для зеркала репозитория.
 * Проекта в снимке нет: два проекта одного репозитория делят одну строку.
 */
export interface PullRequestMirrorFact {
  id: string;
  repositoryId: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  state: string;
}

/**
 * Пишет pull request в зеркало по природному ключу.
 * Повтор того же репозитория и номера обновляет ту же строку и сохраняет её id.
 */
export async function savePullRequestMirror(
  store: PullRequestMirrorStore,
  fact: PullRequestMirrorFact,
): Promise<PullRequest> {
  const key = pullRequestNaturalKey(fact.repositoryId, fact.pullRequestNumber);
  const existing = await store.find(key.repositoryId, key.pullRequestNumber);
  const pullRequest = definePullRequest({
    id: existing === null ? fact.id : existing.id,
    repositoryId: key.repositoryId,
    pullRequestNumber: key.pullRequestNumber,
    title: fact.title,
    authorLogin: fact.authorLogin,
    state: fact.state,
  });
  await store.save(pullRequest);
  const stored = await store.find(pullRequest.repositoryId, pullRequest.pullRequestNumber);
  if (stored === null) {
    throw new DomainError(DOMAIN_ERROR.PULL_REQUEST_MIRROR, 'pull request не записан в зеркало');
  }
  return stored;
}
