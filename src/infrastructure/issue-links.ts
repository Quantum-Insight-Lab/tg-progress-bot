import type { Transaction } from 'kysely';
import { mirrorIssueLink, type IssueLinkStore } from '../domain/github/issue-link.ts';
import type { IssueDependency } from '../domain/github/issue-dependency.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function storeOf(trx: Transaction<Database>): IssueLinkStore {
  return {
    async findIssueId(repositoryId, issueNumber) {
      const row = await trx
        .selectFrom('issues')
        .select('id')
        .where('repository_id', '=', repositoryId)
        .where('issue_number', '=', issueNumber)
        .executeTakeFirst();
      return row?.id ?? null;
    },
    async add(link: IssueDependency) {
      await trx
        .insertInto('issue_dependencies')
        .values({
          issue_id: link.issueId,
          depends_on_issue_id: link.dependsOnIssueId,
          link_type: link.linkType,
        })
        .onConflict((conflict) => conflict.columns(['issue_id', 'depends_on_issue_id', 'link_type']).doNothing())
        .execute();
    },
    async remove(link: IssueDependency) {
      await trx
        .deleteFrom('issue_dependencies')
        .where('issue_id', '=', link.issueId)
        .where('depends_on_issue_id', '=', link.dependsOnIssueId)
        .where('link_type', '=', link.linkType)
        .execute();
    },
  };
}

/**
 * Кладёт факт `github.issue_links_changed` в зеркало связей.
 * Оба issue должны уже лежать в зеркале репозитория. Записи в GitHub нет.
 */
export async function mirrorGithubIssueLink(
  trx: Transaction<Database>,
  payload: PayloadByType['github.issue_links_changed'],
): Promise<boolean> {
  return mirrorIssueLink(storeOf(trx), payload);
}
