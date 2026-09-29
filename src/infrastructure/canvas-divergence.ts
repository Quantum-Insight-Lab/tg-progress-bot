import { sql, type Kysely } from 'kysely';
import {
  canvasDivergenceDate,
  projectDiverges,
  type DivergenceCommit,
  type DivergenceIssue,
  type DivergenceMember,
  type DivergencePullRequest,
  type DivergenceTask,
} from '../domain/progress/divergence.ts';
import type { Database } from './database.ts';

/**
 * Сигнал расхождения для строки канваса.
 * Считается по закрытым суткам перед датой канваса. Задачи и блокеры не меняет.
 * Красный CI в факты движения не входит.
 */

async function tablePresent(db: Kysely<Database>, table: string): Promise<boolean> {
  const found = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `.execute(db);
  return found.rows.length > 0;
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

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function instantOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return instant(value);
}

async function repositoryOf(db: Kysely<Database>, projectId: string): Promise<string | null> {
  if (!(await columnPresent(db, 'projects', 'repository_id'))) return null;
  const found = await sql<{ repository_id: string | null }>`
    SELECT repository_id FROM projects WHERE id = ${projectId}::uuid
  `.execute(db);
  const repositoryId = found.rows[0]?.repository_id ?? null;
  if (repositoryId === null || repositoryId.trim().length === 0) return null;
  return repositoryId;
}

async function membersOf(db: Kysely<Database>, projectId: string): Promise<DivergenceMember[]> {
  if (!(await tablePresent(db, 'project_members')) || !(await tablePresent(db, 'users'))) return [];
  if (!(await columnPresent(db, 'users', 'github_login'))) return [];
  const found = await sql<{ github_login: string | null }>`
    SELECT users.github_login
    FROM project_members
    JOIN users ON users.id = project_members.user_id
    WHERE project_members.project_id = ${projectId}::uuid
  `.execute(db);
  return found.rows.map((row) => ({ projectId, githubLogin: row.github_login }));
}

async function commitsOf(db: Kysely<Database>, repositoryId: string): Promise<DivergenceCommit[]> {
  if (!(await tablePresent(db, 'commits'))) return [];
  const found = await sql<{ author_login: string; created_at: Date | string }>`
    SELECT author_login, created_at
    FROM commits
    WHERE repository_id = ${repositoryId}
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId,
    authorLogin: row.author_login,
    createdAt: instant(row.created_at),
  }));
}

async function pullRequestsOf(db: Kysely<Database>, repositoryId: string): Promise<DivergencePullRequest[]> {
  if (!(await tablePresent(db, 'pull_requests'))) return [];
  if (!(await columnPresent(db, 'pull_requests', 'merged_at'))) return [];
  const found = await sql<{ state: string; author_login: string; merged_at: Date | string | null }>`
    SELECT state, author_login, merged_at
    FROM pull_requests
    WHERE repository_id = ${repositoryId}
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId,
    state: row.state,
    authorLogin: row.author_login,
    mergedAt: instantOrNull(row.merged_at),
  }));
}

async function issuesOf(db: Kysely<Database>, repositoryId: string): Promise<DivergenceIssue[]> {
  if (!(await tablePresent(db, 'issues'))) return [];
  const found = await sql<{ state: string; closed_by_login: string | null; closed_at: Date | string | null }>`
    SELECT state, closed_by_login, closed_at
    FROM issues
    WHERE repository_id = ${repositoryId}
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId,
    state: row.state,
    closedByLogin: row.closed_by_login,
    closedAt: instantOrNull(row.closed_at),
  }));
}

async function tasksOf(db: Kysely<Database>, projectId: string): Promise<DivergenceTask[]> {
  if (!(await tablePresent(db, 'tasks'))) return [];
  const found = await sql<{ created_at: Date | string; completed_at: Date | string | null }>`
    SELECT created_at, completed_at
    FROM tasks
    WHERE project_id = ${projectId}::uuid
  `.execute(db);
  return found.rows.map((row) => ({
    projectId,
    createdAt: instant(row.created_at),
    completedAt: instantOrNull(row.completed_at),
  }));
}

/**
 * Горит ли строка расхождения на канвасе этой даты.
 * Чтение фактов. Статусы задач, блокеры и журнал не меняются.
 */
export async function loadCanvasDivergence(
  db: Kysely<Database>,
  projectId: string,
  canvasDate: string,
  timezone: string,
): Promise<boolean> {
  const repositoryId = await repositoryOf(db, projectId);
  if (repositoryId === null) return false;
  const date = canvasDivergenceDate(canvasDate);
  return projectDiverges({
    project: { projectId, timezone, repositoryId },
    date,
    members: await membersOf(db, projectId),
    commits: await commitsOf(db, repositoryId),
    pullRequests: await pullRequestsOf(db, repositoryId),
    issues: await issuesOf(db, repositoryId),
    tasks: await tasksOf(db, projectId),
  });
}
