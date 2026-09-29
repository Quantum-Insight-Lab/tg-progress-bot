import type { Transaction } from 'kysely';
import { commitTailStartsAt } from '../domain/github/commit.ts';
import { saveCommitTail, type CommitMirrorStore } from '../domain/github/commit-mirror.ts';
import { defineCommit, type Commit } from '../domain/github/commit.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function storeOf(trx: Transaction<Database>): CommitMirrorStore {
  return {
    async find(repositoryId, sha) {
      const row = await trx
        .selectFrom('commits')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('sha', '=', sha)
        .executeTakeFirst();
      if (row === undefined) return null;
      return defineCommit({
        id: row.id,
        repositoryId: row.repository_id,
        sha: row.sha,
        message: row.message,
        authorLogin: row.author_login,
        createdAt: iso(row.created_at),
      });
    },
    async save(commit: Commit) {
      await trx
        .insertInto('commits')
        .values({
          id: commit.id,
          repository_id: commit.repositoryId,
          sha: commit.sha,
          message: commit.message,
          author_login: commit.authorLogin,
          created_at: new Date(commit.createdAt),
        })
        .onConflict((conflict) =>
          conflict.columns(['repository_id', 'sha']).doUpdateSet({
            message: commit.message,
            author_login: commit.authorLogin,
            created_at: new Date(commit.createdAt),
          }),
        )
        .execute();
    },
    async dropOutsideTail(repositoryId, now) {
      await trx
        .deleteFrom('commits')
        .where('repository_id', '=', repositoryId)
        .where('created_at', '<', new Date(commitTailStartsAt(now)))
        .execute();
    },
  };
}

/** Кладёт факт `github.commits_pushed` в хвост зеркала репозитория. */
export async function mirrorGithubCommits(
  trx: Transaction<Database>,
  payload: PayloadByType['github.commits_pushed'],
  now: Date,
  nextId: () => string,
): Promise<Commit[]> {
  return saveCommitTail(
    storeOf(trx),
    payload.repository_id,
    payload.commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      authorLogin: commit.author_login,
      createdAt: commit.created_at,
    })),
    now,
    nextId,
  );
}
