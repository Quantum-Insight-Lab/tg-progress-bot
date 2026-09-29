import { sql, type Kysely } from 'kysely';
import { ciStatus, type CiStatus } from '../domain/github/ci-status.ts';
import {
  githubCanvasLine,
  type GithubCanvasCommit,
  type GithubCanvasLine,
  type GithubCanvasMilestone,
  type GithubCanvasPullRequest,
} from '../domain/github/canvas-line.ts';
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

function ciOf(value: string | null): CiStatus | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return ciStatus(trimmed);
}

function dueOnText(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  return date ?? null;
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
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

async function pullRequestsOf(db: Kysely<Database>, repositoryId: string): Promise<GithubCanvasPullRequest[]> {
  if (!(await tablePresent(db, 'pull_requests'))) return [];
  const rows = await db
    .selectFrom('pull_requests')
    .select(['state'])
    .where('repository_id', '=', repositoryId)
    .execute();
  return rows.map((row) => ({ state: row.state }));
}

async function commitsOf(db: Kysely<Database>, repositoryId: string): Promise<GithubCanvasCommit[]> {
  if (!(await tablePresent(db, 'commits'))) return [];
  const rows = await db
    .selectFrom('commits')
    .select(['created_at'])
    .where('repository_id', '=', repositoryId)
    .execute();
  return rows.map((row) => ({ createdAt: instant(row.created_at) }));
}

async function milestonesOf(db: Kysely<Database>, repositoryId: string): Promise<GithubCanvasMilestone[]> {
  if (!(await tablePresent(db, 'milestones'))) return [];
  const rows = await db
    .selectFrom('milestones')
    .select(['milestone_number', 'title', 'state', 'due_on'])
    .where('repository_id', '=', repositoryId)
    .execute();
  return rows.map((row) => ({
    milestoneNumber: row.milestone_number,
    title: row.title,
    state: row.state,
    dueOn: dueOnText(row.due_on),
  }));
}

/**
 * Строка GitHub проекта на сутки канваса.
 * Нет репозитория — пусто: канвас строку не занимает.
 * Зеркало читается по репозиторию, не копируется в проект.
 */
export async function loadGithubCanvasLine(
  db: Kysely<Database>,
  projectId: string,
  canvasDate: string,
  timezone: string,
): Promise<GithubCanvasLine | null> {
  const repositoryId = await repositoryOf(db, projectId);
  if (repositoryId === null || !(await tablePresent(db, 'repositories'))) return null;
  const ciColumn = await columnPresent(db, 'repositories', 'default_branch_ci');
  const found = await db
    .selectFrom('repositories')
    .select(['owner', 'name'])
    .where('id', '=', repositoryId)
    .executeTakeFirst();
  if (found === undefined) return null;
  let ci: CiStatus | null = null;
  if (ciColumn) {
    const status = await db
      .selectFrom('repositories')
      .select(['default_branch_ci'])
      .where('id', '=', repositoryId)
      .executeTakeFirst();
    ci = ciOf(status?.default_branch_ci ?? null);
  }
  return githubCanvasLine({
    owner: found.owner,
    name: found.name,
    ci,
    pullRequests: await pullRequestsOf(db, repositoryId),
    commits: await commitsOf(db, repositoryId),
    milestones: await milestonesOf(db, repositoryId),
    canvasDate,
    timezone,
  });
}
