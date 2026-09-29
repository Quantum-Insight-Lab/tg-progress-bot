import type { Transaction } from 'kysely';
import { savePullRequestMirror, type PullRequestMirrorStore } from '../domain/github/pull-request-mirror.ts';
import { definePullRequest, type PullRequest } from '../domain/github/pull-request.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function storeOf(trx: Transaction<Database>): PullRequestMirrorStore {
  return {
    async find(repositoryId, pullRequestNumber) {
      const row = await trx
        .selectFrom('pull_requests')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('pull_request_number', '=', pullRequestNumber)
        .executeTakeFirst();
      if (row === undefined) return null;
      return definePullRequest({
        id: row.id,
        repositoryId: row.repository_id,
        pullRequestNumber: row.pull_request_number,
        title: row.title,
        authorLogin: row.author_login,
        state: row.state,
      });
    },
    async save(pullRequest: PullRequest) {
      await trx
        .insertInto('pull_requests')
        .values({
          id: pullRequest.id,
          repository_id: pullRequest.repositoryId,
          pull_request_number: pullRequest.pullRequestNumber,
          title: pullRequest.title,
          author_login: pullRequest.authorLogin,
          state: pullRequest.state,
        })
        .onConflict((conflict) =>
          conflict.columns(['repository_id', 'pull_request_number']).doUpdateSet({
            title: pullRequest.title,
            author_login: pullRequest.authorLogin,
            state: pullRequest.state,
          }),
        )
        .execute();
    },
  };
}

/** Кладёт факт `github.pull_request_changed` в зеркало репозитория. */
export async function mirrorGithubPullRequest(
  trx: Transaction<Database>,
  payload: PayloadByType['github.pull_request_changed'],
  id: string,
): Promise<PullRequest> {
  return savePullRequestMirror(storeOf(trx), {
    id,
    repositoryId: payload.repository_id,
    pullRequestNumber: payload.pull_request_number,
    title: payload.title,
    authorLogin: payload.author_login,
    state: payload.state,
  });
}
