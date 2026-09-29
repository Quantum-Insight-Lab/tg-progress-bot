import { sql, type Kysely } from 'kysely';
import {
  dueDivergence,
  publishDivergenceDetected,
  type DivergenceCommit,
  type DivergenceFacts,
  type DivergenceIssue,
  type DivergenceMember,
  type DivergenceNotice,
  type DivergenceProject,
  type DivergencePullRequest,
  type DivergenceTask,
} from '../domain/progress/divergence.ts';
import { EVENT_TYPES } from '../events/index.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

interface ProjectRow {
  id: string;
  timezone: string;
  repository_id: string | null;
}

interface MemberRow {
  project_id: string;
  github_login: string | null;
}

interface CommitRow {
  repository_id: string;
  author_login: string;
  created_at: Date | string;
}

interface PullRequestRow {
  repository_id: string;
  state: string;
  author_login: string;
  merged_at: Date | string | null;
}

interface IssueRow {
  repository_id: string;
  state: string;
  closed_by_login: string | null;
  closed_at: Date | string | null;
}

interface TaskRow {
  project_id: string;
  created_at: Date | string;
  completed_at: Date | string | null;
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function instantOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return instant(value);
}

async function projectsOf(db: Kysely<Database>): Promise<DivergenceProject[]> {
  const found = await sql<ProjectRow>`
    SELECT id::text AS id, timezone, repository_id
    FROM projects
    ORDER BY id
  `.execute(db);
  return found.rows.map((row) => ({
    projectId: row.id,
    timezone: row.timezone,
    repositoryId: row.repository_id,
  }));
}

async function membersOf(db: Kysely<Database>): Promise<DivergenceMember[]> {
  const found = await sql<MemberRow>`
    SELECT project_members.project_id::text AS project_id, users.github_login
    FROM project_members
    JOIN users ON users.id = project_members.user_id
    ORDER BY project_members.project_id, project_members.user_id
  `.execute(db);
  return found.rows.map((row) => ({ projectId: row.project_id, githubLogin: row.github_login }));
}

async function commitsOf(db: Kysely<Database>): Promise<DivergenceCommit[]> {
  const found = await sql<CommitRow>`
    SELECT repository_id, author_login, created_at
    FROM commits
    ORDER BY repository_id, sha
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId: row.repository_id,
    authorLogin: row.author_login,
    createdAt: instant(row.created_at),
  }));
}

async function pullRequestsOf(db: Kysely<Database>): Promise<DivergencePullRequest[]> {
  const found = await sql<PullRequestRow>`
    SELECT repository_id, state, author_login, merged_at
    FROM pull_requests
    ORDER BY repository_id, pull_request_number
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId: row.repository_id,
    state: row.state,
    authorLogin: row.author_login,
    mergedAt: instantOrNull(row.merged_at),
  }));
}

async function issuesOf(db: Kysely<Database>): Promise<DivergenceIssue[]> {
  const found = await sql<IssueRow>`
    SELECT repository_id, state, closed_by_login, closed_at
    FROM issues
    ORDER BY repository_id, issue_number
  `.execute(db);
  return found.rows.map((row) => ({
    repositoryId: row.repository_id,
    state: row.state,
    closedByLogin: row.closed_by_login,
    closedAt: instantOrNull(row.closed_at),
  }));
}

async function tasksOf(db: Kysely<Database>): Promise<DivergenceTask[]> {
  const found = await sql<TaskRow>`
    SELECT project_id::text AS project_id, created_at, completed_at
    FROM tasks
    ORDER BY project_id, number
  `.execute(db);
  return found.rows.map((row) => ({
    projectId: row.project_id,
    createdAt: instant(row.created_at),
    completedAt: instantOrNull(row.completed_at),
  }));
}

async function takenKeys(db: Kysely<Database>): Promise<Set<string>> {
  const found = await sql<{ idempotency_key: string }>`
    SELECT idempotency_key
    FROM events
    WHERE event_type = ${EVENT_TYPES.DIVERGENCE_DETECTED}
  `.execute(db);
  return new Set(found.rows.map((row) => row.idempotency_key));
}

async function publishOne(db: Kysely<Database>, notice: DivergenceNotice, now: Date): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await publishDivergenceDetected(
      {
        seen(idempotencyKey) {
          return trx
            .selectFrom('events')
            .select('id')
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst()
            .then((found) => (found === undefined ? null : { eventId: found.id }));
        },
      },
      createEventJournal(trx),
      { ...notice, occurredAt: now },
    );
  });
}

/**
 * A-36. Закрытые сутки с движением участника и тишиной в задачах пишут `divergence.detected`.
 * Повтор тех же суток второе событие не пишет. Задачи и блокеры не меняет.
 * Сбой одного проекта не отменяет остальные, затем всплывает.
 */
export async function noticeProjectDivergence(db: Kysely<Database>, now: Date): Promise<void> {
  const facts: Omit<DivergenceFacts, 'now' | 'projects' | 'takenKeys'> = {
    members: await membersOf(db),
    commits: await commitsOf(db),
    pullRequests: await pullRequestsOf(db),
    issues: await issuesOf(db),
    tasks: await tasksOf(db),
  };
  const projects = await projectsOf(db);
  const taken = await takenKeys(db);
  const failures: unknown[] = [];
  for (const project of projects) {
    let notices: DivergenceNotice[];
    try {
      notices = dueDivergence({ ...facts, now, projects: [project], takenKeys: taken });
    } catch (error) {
      failures.push(error);
      continue;
    }
    for (const notice of notices) {
      try {
        await publishOne(db, notice, now);
        taken.add(notice.idempotencyKey);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('сигнал расхождения не записан');
}
