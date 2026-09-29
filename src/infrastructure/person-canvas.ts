import { sql, type Kysely } from 'kysely';
import { personBacklogPlace, type PersonBacklogIssue, type PersonBacklogPlace } from '../domain/progress/person-place.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { Database } from './database.ts';

/** Человек канваса и его место в бэклоге. Считается на лету, в строку не записывается. */
export interface CanvasPerson {
  name: string;
  place: PersonBacklogPlace;
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

async function tablePresent(db: Kysely<Database>, table: string): Promise<boolean> {
  const found = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `.execute(db);
  return found.rows.length > 0;
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
 * Issues репозитория и логины из `issue_assignees`.
 * `closed_by_login` в срез не входит: место строится по назначению.
 */
async function loadAssigneeIssues(db: Kysely<Database>, repositoryId: string): Promise<PersonBacklogIssue[]> {
  if (!(await tablePresent(db, 'issues'))) return [];
  const issues = await db
    .selectFrom('issues')
    .select(['id', 'repository_id', 'issue_number', 'state', 'state_reason'])
    .where('repository_id', '=', repositoryId)
    .orderBy('issue_number')
    .execute();
  const logins = new Map<string, string[]>();
  if (issues.length > 0 && (await tablePresent(db, 'issue_assignees'))) {
    const assignees = await db
      .selectFrom('issue_assignees')
      .select(['issue_id', 'login'])
      .where(
        'issue_id',
        'in',
        issues.map((issue) => issue.id),
      )
      .execute();
    for (const row of assignees) {
      const list = logins.get(row.issue_id) ?? [];
      list.push(row.login);
      logins.set(row.issue_id, list);
    }
  }
  return issues.map((issue) => ({
    repositoryId: issue.repository_id,
    issueNumber: issue.issue_number,
    state: issue.state,
    stateReason: issue.state_reason,
    assignees: logins.get(issue.id) ?? [],
  }));
}

/**
 * Место исполнителя канваса.
 * Без логина среза нет. Чужой логин отдельной строкой не становится: читается один человек.
 */
export async function loadCanvasPerson(db: Kysely<Database>, projectId: string, assigneeId: string): Promise<CanvasPerson> {
  const user = await db
    .selectFrom('users')
    .select(['name', 'github_login'])
    .where('id', '=', assigneeId)
    .executeTakeFirst();
  if (user === undefined) throw new DomainError(DOMAIN_ERROR.USER_NOT_FOUND, 'исполнителя нет');
  const repositoryId = await repositoryOf(db, projectId);
  const issues = repositoryId === null ? [] : await loadAssigneeIssues(db, repositoryId);
  return {
    name: user.name,
    place: personBacklogPlace(user.github_login, repositoryId, issues),
  };
}
