import { sql, type Kysely, type Transaction } from 'kysely';
import { ciStatus, type CiStatus } from '../domain/github/ci-status.ts';
import {
  publishPrStalled,
  repositoryStallFacts,
  type PrStallNotice,
  type StallFacts,
  type StallMember,
  type StallProject,
  type StallPullRequest,
  type StallRepository,
} from '../domain/github/stall.ts';
import type { Logger } from '../domain/shared/logger.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

interface RepositoryRow {
  id: string;
  default_branch_ci: string | null;
}

interface ProjectRow {
  id: string;
  repository_id: string | null;
  timezone: string;
}

interface MemberRow {
  project_id: string;
  github_login: string | null;
}

interface PullRequestRow {
  id: string;
  repository_id: string;
  pull_request_number: number | string;
  author_login: string;
  state: string;
  ci_status: string | null;
  updated_at: Date | string;
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function positive(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error('номер pull request повреждён');
}

function ciOf(value: string | null): CiStatus | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return ciStatus(trimmed);
}

async function repositoriesOf(db: Kysely<Database> | Transaction<Database>): Promise<StallRepository[]> {
  const found = await sql<RepositoryRow>`
    SELECT id, default_branch_ci FROM repositories ORDER BY id
  `.execute(db);
  return found.rows.map((row) => ({ repositoryId: row.id, defaultBranchCi: ciOf(row.default_branch_ci) }));
}

async function projectsOf(db: Kysely<Database> | Transaction<Database>): Promise<StallProject[]> {
  const found = await sql<ProjectRow>`
    SELECT id::text AS id, repository_id, timezone FROM projects ORDER BY id
  `.execute(db);
  return found.rows.map((row) => ({
    projectId: row.id,
    repositoryId: row.repository_id,
    timezone: row.timezone,
  }));
}

async function membersOf(db: Kysely<Database> | Transaction<Database>): Promise<StallMember[]> {
  const found = await sql<MemberRow>`
    SELECT project_members.project_id::text AS project_id, users.github_login
    FROM project_members
    JOIN users ON users.id = project_members.user_id
    ORDER BY project_members.project_id, project_members.user_id
  `.execute(db);
  return found.rows.map((row) => ({ projectId: row.project_id, githubLogin: row.github_login }));
}

async function pullRequestsOf(db: Kysely<Database> | Transaction<Database>): Promise<StallPullRequest[]> {
  const found = await sql<PullRequestRow>`
    SELECT id::text AS id,
           repository_id,
           pull_request_number,
           author_login,
           state,
           ci_status,
           updated_at
    FROM pull_requests
    ORDER BY repository_id, pull_request_number
  `.execute(db);
  return found.rows.map((row) => ({
    id: row.id,
    repositoryId: row.repository_id,
    pullRequestNumber: positive(row.pull_request_number),
    authorLogin: row.author_login,
    state: row.state,
    ciStatus: ciOf(row.ci_status),
    updatedAt: instant(row.updated_at),
  }));
}

/** Срез застоя из зеркала. Задачи и блокеры не читает и не пишет. */
export async function readRepositoryStall(db: Kysely<Database>, now: Date): Promise<StallFacts> {
  return repositoryStallFacts({
    now,
    repositories: await repositoriesOf(db),
    projects: await projectsOf(db),
    members: await membersOf(db),
    pullRequests: await pullRequestsOf(db),
  });
}

async function publishOne(db: Kysely<Database>, logger: Logger, notice: PrStallNotice, now: Date): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await publishPrStalled(
      {
        seen(idempotencyKey) {
          return trx
            .selectFrom('events')
            .select(['id'])
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst()
            .then((found) => (found === undefined ? null : { eventId: found.id }));
        },
      },
      createEventJournal(trx, logger),
      { ...notice, occurredAt: now },
    );
  });
}

/**
 * A-35. Открытый PR участника без движения пишет `repo.pr_stalled`.
 * Повтор в те же сутки второе событие не пишет. Задачи и блокеры не меняет.
 */
export async function noticeStalePullRequests(db: Kysely<Database>, logger: Logger, now: Date): Promise<void> {
  const facts = await readRepositoryStall(db, now);
  const failures: unknown[] = [];
  for (const notice of facts.notices) {
    try {
      await publishOne(db, logger, notice, now);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('застой pull request не записан');
}
