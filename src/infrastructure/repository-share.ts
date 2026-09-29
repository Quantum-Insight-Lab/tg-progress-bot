import { sql, type Kysely } from 'kysely';
import { projectShareRatio } from '../domain/progress/no-data.ts';
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

async function columnPresent(db: Kysely<Database>, table: string, column: string): Promise<boolean> {
  const found = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `.execute(db);
  return found.rows.length > 0;
}

/**
 * Процент проекта для строки канваса.
 * Колонки репозитория нет — репозиторий не подключён, числа нет.
 * Пустой знаменатель тоже даёт пусто, не ноль.
 */
export async function loadProjectShareRatio(db: Kysely<Database>, projectId: string): Promise<number | null> {
  if (!(await columnPresent(db, 'projects', 'repository_id'))) return null;
  const linked = await db
    .selectFrom('projects')
    .select(['repository_id'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  const repositoryId = linked?.repository_id ?? null;
  if (repositoryId === null || repositoryId.trim().length === 0) return null;
  const issues: IssueRow[] = [];
  if (await columnPresent(db, 'issues', 'issue_number')) {
    const rows = await db
      .selectFrom('issues')
      .select(['repository_id', 'issue_number', 'state', 'state_reason'])
      .where('repository_id', '=', repositoryId)
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
  const reading = projectRepositoryReadings([{ projectId, repositoryId, memberKeys: [] }], issues)[0];
  return projectShareRatio(reading?.share ?? null);
}
