import { ciStatus, type CiStatus } from './ci-status.ts';
import { pullRequestNaturalKey } from './pull-request.ts';
import { githubRepositoryId } from './repository.ts';

/** Порт записи CI внутри уже открытой транзакции. Строку без зеркала не создаёт. */
export interface WorkflowMirrorStore {
  setDefaultBranchCi(repositoryId: string, status: CiStatus): Promise<void>;
  setPullRequestCi(repositoryId: string, pullRequestNumber: number, status: CiStatus): Promise<void>;
}

/**
 * Снимок завершённого workflow для зеркала репозитория.
 * Проекта в снимке нет: CI основной ветки один на репозиторий.
 */
export interface WorkflowMirrorFact {
  repositoryId: string;
  isDefaultBranch: boolean;
  conclusion: string;
  pullRequestNumbers: readonly number[];
}

/**
 * Пишет CI в зеркало.
 * Основная ветка обновляет `repositories.default_branch_ci`.
 * Номера pull request обновляют `ci_status` уже лежащих строк и не заводят новую.
 * Задач и блокеров этот акт не касается.
 */
export async function saveWorkflowMirror(store: WorkflowMirrorStore, fact: WorkflowMirrorFact): Promise<void> {
  const repositoryId = githubRepositoryId(fact.repositoryId);
  const status = ciStatus(fact.conclusion);
  if (fact.isDefaultBranch) {
    await store.setDefaultBranchCi(repositoryId, status);
  }
  const seen = new Set<number>();
  for (const pullRequestNumber of fact.pullRequestNumbers) {
    const key = pullRequestNaturalKey(repositoryId, pullRequestNumber);
    if (seen.has(key.pullRequestNumber)) continue;
    seen.add(key.pullRequestNumber);
    await store.setPullRequestCi(key.repositoryId, key.pullRequestNumber, status);
  }
}
