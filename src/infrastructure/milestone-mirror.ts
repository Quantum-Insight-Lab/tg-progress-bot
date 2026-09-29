import type { Transaction } from 'kysely';
import { saveMilestoneMirror, type MilestoneMirrorStore } from '../domain/github/milestone-mirror.ts';
import { defineMilestone, type Milestone } from '../domain/github/milestone.ts';
import type { PayloadByType } from '../events/index.ts';
import type { Database } from './database.ts';

function dueOnText(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  return date ?? null;
}

function storeOf(trx: Transaction<Database>): MilestoneMirrorStore {
  return {
    async find(repositoryId, milestoneNumber) {
      const row = await trx
        .selectFrom('milestones')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('milestone_number', '=', milestoneNumber)
        .executeTakeFirst();
      if (row === undefined) return null;
      return defineMilestone({
        id: row.id,
        repositoryId: row.repository_id,
        milestoneNumber: row.milestone_number,
        title: row.title,
        state: row.state,
        dueOn: dueOnText(row.due_on),
      });
    },
    async save(milestone: Milestone) {
      await trx
        .insertInto('milestones')
        .values({
          id: milestone.id,
          repository_id: milestone.repositoryId,
          milestone_number: milestone.milestoneNumber,
          title: milestone.title,
          state: milestone.state,
          due_on: milestone.dueOn,
        })
        .onConflict((conflict) =>
          conflict.columns(['repository_id', 'milestone_number']).doUpdateSet({
            title: milestone.title,
            state: milestone.state,
            due_on: milestone.dueOn,
          }),
        )
        .execute();
    },
  };
}

/** Кладёт факт `github.milestone_changed` в зеркало репозитория. */
export async function mirrorGithubMilestone(
  trx: Transaction<Database>,
  payload: PayloadByType['github.milestone_changed'],
  id: string,
): Promise<Milestone> {
  return saveMilestoneMirror(storeOf(trx), {
    id,
    repositoryId: payload.repository_id,
    milestoneNumber: payload.milestone_number,
    title: payload.title,
    state: payload.state,
    dueOn: payload.due_on,
  });
}
