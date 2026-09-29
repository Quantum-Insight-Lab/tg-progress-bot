import type { Kysely } from 'kysely';
import {
  projectRepositoryReadings,
  type IssueRow,
  type ProjectMemberSlice,
  type ProjectProgress,
} from '../domain/progress/repository-share.ts';
import type { Database } from './database.ts';

/**
 * Доля бэклога читается из таблицы `issues` по id репозитория.
 * Проект в этот запрос не входит: у него только ссылка на репозиторий.
 */
export async function loadProjectRepositoryReadings(
  db: Kysely<Database>,
  projects: readonly ProjectMemberSlice[],
): Promise<ProjectProgress[]> {
  const repositoryIds: string[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const repositoryId = project.repositoryId;
    if (repositoryId === null) continue;
    const id = repositoryId.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    repositoryIds.push(id);
  }
  const issues: IssueRow[] = [];
  if (repositoryIds.length > 0) {
    const rows = await db
      .selectFrom('issues')
      .select(['repository_id', 'issue_number', 'state', 'state_reason'])
      .where('repository_id', 'in', repositoryIds)
      .orderBy('repository_id')
      .orderBy('issue_number')
      .execute();
    for (const row of rows) {
      issues.push({
        repositoryId: row.repository_id,
        issueNumber: row.issue_number,
        state: row.state,
        stateReason: row.state_reason,
      });
    }
  }
  return projectRepositoryReadings(projects, issues);
}
