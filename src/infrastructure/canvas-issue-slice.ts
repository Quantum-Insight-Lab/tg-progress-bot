import { sql, type Kysely } from 'kysely';
import {
  canvasIssueSlice,
  type CanvasIssueSlice,
  type CanvasMirrorIssue,
  type CanvasSliceLink,
  type CanvasSliceUser,
} from '../domain/progress/canvas-issue-slice.ts';
import type { Database } from './database.ts';

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

async function tablePresent(db: Kysely<Database>, table: string): Promise<boolean> {
  const found = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `.execute(db);
  return found.rows.length > 0;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

async function repositoryOf(db: Kysely<Database>, projectId: string): Promise<string | null> {
  if (!(await columnPresent(db, 'projects', 'repository_id'))) return null;
  const linked = await db
    .selectFrom('projects')
    .select(['repository_id'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  const repositoryId = linked?.repository_id ?? null;
  if (repositoryId === null || repositoryId.trim().length === 0) return null;
  return repositoryId;
}

/**
 * Срез issues репозитория проекта: assignees, связи и пользователи бота.
 * Без репозитория или без таблицы зеркала срез пустой.
 * Связь на issue вне этого репозитория к пункту не пишется.
 */
export async function loadCanvasIssueSlice(db: Kysely<Database>, projectId: string): Promise<CanvasIssueSlice> {
  const repositoryId = await repositoryOf(db, projectId);
  if (repositoryId === null || !(await tablePresent(db, 'issues'))) {
    return canvasIssueSlice(null, [], []);
  }
  const issues = await db
    .selectFrom('issues')
    .select(['id', 'repository_id', 'issue_number', 'title', 'state', 'state_reason', 'closed_at'])
    .where('repository_id', '=', repositoryId)
    .orderBy('issue_number')
    .execute();
  if (issues.length === 0) return canvasIssueSlice(repositoryId, [], []);
  const ids = issues.map((issue) => issue.id);
  const numbers = new Map(issues.map((issue) => [issue.id, issue.issue_number]));
  const logins = new Map<string, string[]>();
  if (await tablePresent(db, 'issue_assignees')) {
    const assignees = await db
      .selectFrom('issue_assignees')
      .select(['issue_id', 'login'])
      .where('issue_id', 'in', ids)
      .execute();
    for (const row of assignees) {
      const list = logins.get(row.issue_id) ?? [];
      list.push(row.login);
      logins.set(row.issue_id, list);
    }
  }
  const links = new Map<string, CanvasSliceLink[]>();
  if (await tablePresent(db, 'issue_dependencies')) {
    const dependencies = await db
      .selectFrom('issue_dependencies')
      .select(['issue_id', 'depends_on_issue_id', 'link_type'])
      .where('issue_id', 'in', ids)
      .execute();
    for (const row of dependencies) {
      const target = numbers.get(row.depends_on_issue_id);
      if (target === undefined) continue;
      const list = links.get(row.issue_id) ?? [];
      list.push({ dependsOnIssueNumber: target, linkType: row.link_type });
      links.set(row.issue_id, list);
    }
  }
  const people = await db.selectFrom('users').select(['name', 'github_login']).orderBy('name').execute();
  const users: CanvasSliceUser[] = people.map((row) => ({ name: row.name, githubLogin: row.github_login }));
  const mirror: CanvasMirrorIssue[] = issues.map((issue) => ({
    repositoryId: issue.repository_id,
    issueNumber: issue.issue_number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason,
    closedAt: issue.closed_at === null ? null : iso(issue.closed_at),
    assignees: logins.get(issue.id) ?? [],
    links: links.get(issue.id) ?? [],
  }));
  return canvasIssueSlice(repositoryId, mirror, users);
}
