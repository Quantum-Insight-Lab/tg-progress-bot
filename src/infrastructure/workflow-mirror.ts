import type { Transaction } from 'kysely';
import { saveWorkflowMirror, type WorkflowMirrorStore } from '../domain/github/workflow-mirror.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function storeOf(trx: Transaction<Database>): WorkflowMirrorStore {
  return {
    async setDefaultBranchCi(repositoryId, status) {
      await trx
        .updateTable('repositories')
        .set({ default_branch_ci: status })
        .where('id', '=', repositoryId)
        .execute();
    },
    async setPullRequestCi(repositoryId, pullRequestNumber, status) {
      await trx
        .updateTable('pull_requests')
        .set({ ci_status: status })
        .where('repository_id', '=', repositoryId)
        .where('pull_request_number', '=', pullRequestNumber)
        .execute();
    },
  };
}

/** Кладёт факт `github.workflow_completed` в зеркало репозитория. Новых строк не создаёт. */
export async function mirrorGithubWorkflow(
  trx: Transaction<Database>,
  payload: PayloadByType['github.workflow_completed'],
): Promise<void> {
  await saveWorkflowMirror(storeOf(trx), {
    repositoryId: payload.repository_id,
    isDefaultBranch: payload.is_default_branch,
    conclusion: payload.conclusion,
    pullRequestNumbers: payload.pull_request_numbers,
  });
}
