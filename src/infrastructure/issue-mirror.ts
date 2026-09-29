import type { Transaction } from 'kysely';
import { issueAssigneeSet } from '../domain/github/issue-assignee.ts';
import { saveIssueMirror, type IssueMirrorStore } from '../domain/github/issue-mirror.ts';
import { defineIssue, type Issue } from '../domain/github/issue.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function storeOf(trx: Transaction<Database>): IssueMirrorStore {
  return {
    async find(repositoryId, issueNumber) {
      const row = await trx
        .selectFrom('issues')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('issue_number', '=', issueNumber)
        .executeTakeFirst();
      if (row === undefined) return null;
      return defineIssue({
        id: row.id,
        repositoryId: row.repository_id,
        issueNumber: row.issue_number,
        title: row.title,
        state: row.state,
        stateReason: row.state_reason,
        closedByLogin: row.closed_by_login,
        updatedAt: iso(row.updated_at),
        closedAt: row.closed_at === null ? null : iso(row.closed_at),
      });
    },
    async save(issue: Issue) {
      await trx
        .insertInto('issues')
        .values({
          id: issue.id,
          repository_id: issue.repositoryId,
          issue_number: issue.issueNumber,
          title: issue.title,
          state: issue.state,
          state_reason: issue.stateReason,
          closed_by_login: issue.closedByLogin,
          updated_at: new Date(issue.updatedAt),
          closed_at: issue.closedAt === null ? null : new Date(issue.closedAt),
        })
        .onConflict((conflict) =>
          conflict.columns(['repository_id', 'issue_number']).doUpdateSet({
            title: issue.title,
            state: issue.state,
            state_reason: issue.stateReason,
            closed_by_login: issue.closedByLogin,
            updated_at: new Date(issue.updatedAt),
            closed_at: issue.closedAt === null ? null : new Date(issue.closedAt),
          }),
        )
        .execute();
    },
  };
}

/** Текущий набор логинов issue. Пустой список снимает все назначения. */
async function replaceAssignees(
  trx: Transaction<Database>,
  issueId: string,
  logins: readonly string[],
): Promise<void> {
  const assignees = issueAssigneeSet(issueId, logins);
  await trx.deleteFrom('issue_assignees').where('issue_id', '=', issueId).execute();
  if (assignees.length === 0) return;
  await trx
    .insertInto('issue_assignees')
    .values(assignees.map((assignee) => ({ issue_id: assignee.issueId, login: assignee.login })))
    .execute();
}

/**
 * Кладёт факт `github.issue_changed` в зеркало репозитория
 * и заменяет набор assignees этим фактом.
 */
export async function mirrorGithubIssue(
  trx: Transaction<Database>,
  payload: PayloadByType['github.issue_changed'],
  id: string,
): Promise<Issue> {
  const issue = await saveIssueMirror(storeOf(trx), {
    id,
    repositoryId: payload.repository_id,
    issueNumber: payload.issue_number,
    title: payload.title,
    state: payload.state,
    stateReason: payload.state_reason,
    closedByLogin: payload.closed_by_login,
    updatedAt: payload.updated_at,
  });
  await replaceAssignees(trx, issue.id, payload.assignees);
  return issue;
}
