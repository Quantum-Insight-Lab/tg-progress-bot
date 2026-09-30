import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { RECONCILE_INTERVAL } from '../config/constants.ts';
import { ciStatus, type CiStatus } from '../domain/github/ci-status.ts';
import {
  missedMirrorFacts,
  publishGithubReconciled,
  reconcileIdempotencyKey,
  reconcileIsDue,
  RECONCILE_FACT_COMMIT,
  RECONCILE_FACT_DEFAULT_BRANCH_CI,
  RECONCILE_FACT_ISSUE,
  RECONCILE_FACT_PULL_REQUEST,
  RECONCILE_FACT_PULL_REQUEST_CI,
  type GithubReconcileSource,
  type MirrorSnapshot,
  type MissedMirrorFact,
  type ReconcileCommitInput,
  type ReconcileIssueInput,
  type ReconcilePullRequestInput,
  type ReconcileRepository,
} from '../domain/github/reconcile.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import { EVENT_TYPES, type PayloadByType } from '../events/index.ts';
import { mirrorGithubCommits } from './commit-mirror.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';
import { mirrorGithubIssue } from './issue-mirror.ts';
import { mirrorGithubPullRequest } from './pull-request-mirror.ts';
import { observeGithubRate } from './github-rate.ts';
import { mirrorGithubWorkflow } from './workflow-mirror.ts';

const MILLISECONDS_PER_MINUTE = 60_000;

interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  default_branch_ci: string | null;
}

interface RunRow {
  repository_id: string;
  started_at: Date | string;
}

interface IssueRow {
  issue_number: number | string;
  title: string;
  state: string;
  state_reason: string | null;
  closed_by_login: string | null;
  updated_at: Date | string;
}

interface AssigneeRow {
  issue_number: number | string;
  login: string;
}

interface PullRequestRow {
  pull_request_number: number | string;
  title: string;
  author_login: string;
  state: string;
  ci_status: string | null;
  updated_at: Date | string;
  merged_at: Date | string | null;
  merged_by_login: string | null;
}

interface CommitRow {
  sha: string;
  message: string;
  author_login: string;
  created_at: Date | string;
}

function instant(value: Date | string): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return instant(value).toISOString();
}

function positive(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error('номер зеркала повреждён');
}

function ciOf(value: string | null): CiStatus | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return ciStatus(trimmed);
}

/** Период хода сверки. Тот же порог, что решает, пора ли читать GitHub. */
export function reconcileIntervalMs(): number {
  return RECONCILE_INTERVAL * MILLISECONDS_PER_MINUTE;
}

async function repositoriesOf(db: Kysely<Database>): Promise<ReconcileRepository[]> {
  const found = await sql<RepositoryRow>`
    SELECT id, owner, name, default_branch_ci FROM repositories ORDER BY id
  `.execute(db);
  return found.rows.map((row) => ({ id: row.id, owner: row.owner, name: row.name }));
}

async function lastRuns(db: Kysely<Database>): Promise<Map<string, Date>> {
  const found = await sql<RunRow>`
    SELECT payload->>'repository_id' AS repository_id, max(created_at) AS started_at
    FROM events
    WHERE event_type = ${EVENT_TYPES.GITHUB_RECONCILED}
    GROUP BY payload->>'repository_id'
  `.execute(db);
  const runs = new Map<string, Date>();
  for (const row of found.rows) {
    if (row.repository_id.trim().length === 0) continue;
    runs.set(row.repository_id, instant(row.started_at));
  }
  return runs;
}

async function snapshotOf(trx: Transaction<Database>, repositoryId: string): Promise<MirrorSnapshot> {
  const repository = await sql<{ default_branch_ci: string | null }>`
    SELECT default_branch_ci FROM repositories WHERE id = ${repositoryId}
  `.execute(trx);
  const issues = await sql<IssueRow>`
    SELECT issue_number, title, state, state_reason, closed_by_login, updated_at
    FROM issues
    WHERE repository_id = ${repositoryId}
    ORDER BY issue_number
  `.execute(trx);
  const assignees = await sql<AssigneeRow>`
    SELECT issues.issue_number, issue_assignees.login
    FROM issue_assignees
    JOIN issues ON issues.id = issue_assignees.issue_id
    WHERE issues.repository_id = ${repositoryId}
    ORDER BY issues.issue_number, issue_assignees.login
  `.execute(trx);
  const logins = new Map<number, string[]>();
  for (const row of assignees.rows) {
    const number = positive(row.issue_number);
    const list = logins.get(number) ?? [];
    list.push(row.login);
    logins.set(number, list);
  }
  const pullRequests = await sql<PullRequestRow>`
    SELECT pull_request_number, title, author_login, state, ci_status, updated_at, merged_at, merged_by_login
    FROM pull_requests
    WHERE repository_id = ${repositoryId}
    ORDER BY pull_request_number
  `.execute(trx);
  const commits = await sql<CommitRow>`
    SELECT sha, message, author_login, created_at
    FROM commits
    WHERE repository_id = ${repositoryId}
    ORDER BY sha
  `.execute(trx);
  const issueFacts: ReconcileIssueInput[] = issues.rows.map((row) => {
    const number = positive(row.issue_number);
    return {
      number,
      title: row.title,
      state: row.state,
      stateReason: row.state_reason,
      assignees: logins.get(number) ?? [],
      closedByLogin: row.closed_by_login,
      updatedAt: iso(row.updated_at) ?? '',
    };
  });
  const pullFacts: ReconcilePullRequestInput[] = pullRequests.rows.map((row) => ({
    number: positive(row.pull_request_number),
    title: row.title,
    authorLogin: row.author_login,
    state: row.state,
    ciStatus: row.ci_status,
    updatedAt: iso(row.updated_at) ?? '',
    mergedAt: iso(row.merged_at),
    mergedByLogin: row.merged_by_login,
  }));
  const commitFacts: ReconcileCommitInput[] = commits.rows.map((row) => ({
    sha: row.sha,
    message: row.message,
    authorLogin: row.author_login,
    createdAt: iso(row.created_at) ?? '',
  }));
  return {
    defaultBranchCi: ciOf(repository.rows[0]?.default_branch_ci ?? null),
    issues: issueFacts,
    pullRequests: pullFacts,
    commits: commitFacts,
  };
}

async function alreadyRan(trx: Transaction<Database>, key: string): Promise<boolean> {
  const found = await sql<{ id: string }>`
    SELECT id FROM events WHERE idempotency_key = ${key}
  `.execute(trx);
  return found.rows.length > 0;
}

async function applyMissed(
  trx: Transaction<Database>,
  repositoryId: string,
  missed: readonly MissedMirrorFact[],
  now: Date,
  nextId: () => string,
): Promise<void> {
  const commits: PayloadByType['github.commits_pushed']['commits'] = [];
  const ci: MissedMirrorFact[] = [];
  for (const fact of missed) {
    if (fact.kind === RECONCILE_FACT_ISSUE) {
      await mirrorGithubIssue(
        trx,
        {
          repository_id: repositoryId,
          issue_number: fact.issue.number,
          title: fact.issue.title,
          state: fact.issue.state,
          state_reason: fact.issue.stateReason,
          assignees: [...fact.issue.assignees],
          closed_by_login: fact.issue.closedByLogin,
          updated_at: fact.issue.updatedAt,
        },
        nextId(),
      );
      continue;
    }
    if (fact.kind === RECONCILE_FACT_PULL_REQUEST) {
      await mirrorGithubPullRequest(
        trx,
        {
          repository_id: repositoryId,
          pull_request_number: fact.pullRequest.number,
          title: fact.pullRequest.title,
          state: fact.pullRequest.state,
          author_login: fact.pullRequest.authorLogin,
          updated_at: fact.pullRequest.updatedAt,
          merged_at: fact.pullRequest.mergedAt,
          merged_by_login: fact.pullRequest.mergedByLogin,
        },
        nextId(),
      );
      continue;
    }
    if (fact.kind === RECONCILE_FACT_COMMIT) {
      commits.push({
        sha: fact.commit.sha,
        author_login: fact.commit.authorLogin,
        message: fact.commit.message,
        created_at: fact.commit.createdAt,
      });
      continue;
    }
    ci.push(fact);
  }
  await mirrorGithubCommits(trx, { repository_id: repositoryId, commits }, now, nextId);
  for (const fact of ci) {
    if (fact.kind === RECONCILE_FACT_DEFAULT_BRANCH_CI) {
      await mirrorGithubWorkflow(trx, {
        repository_id: repositoryId,
        branch: fact.branch,
        is_default_branch: true,
        conclusion: fact.status,
        pull_request_numbers: [],
      });
      continue;
    }
    if (fact.kind !== RECONCILE_FACT_PULL_REQUEST_CI) continue;
    await mirrorGithubWorkflow(trx, {
      repository_id: repositoryId,
      branch: fact.branch,
      is_default_branch: false,
      conclusion: fact.status,
      pull_request_numbers: [fact.number],
    });
  }
}

async function reconcileOne(
  db: Kysely<Database>,
  logger: Logger,
  source: GithubReconcileSource,
  repository: ReconcileRepository,
  now: Date,
  lastRunStartedAt: Date | null,
  nextId: () => string,
): Promise<void> {
  if (!reconcileIsDue(lastRunStartedAt, now)) return;
  const remote = await source.read(repository, now);
  await db.transaction().execute(async (trx) => {
    const key = reconcileIdempotencyKey(repository.id, now);
    if (await alreadyRan(trx, key)) return;
    const mirror = await snapshotOf(trx, repository.id);
    const missed = missedMirrorFacts(repository.id, mirror, remote, now);
    await applyMissed(trx, repository.id, missed, now, nextId);
    await publishGithubReconciled(createEventJournal(trx, logger), {
      repositoryId: repository.id,
      restoredFacts: missed.length,
      runStartedAt: now,
    });
  });
}

/**
 * Сверка зеркала с GitHub.
 * Опрос только дописывает пропущенное. Повтор того же момента старта ничего не меняет.
 * Сбой одного репозитория не отменяет остальные, затем всплывает.
 * Задачи и таблица `blockers` здесь не пишутся.
 */
export async function reconcileGithubMirror(
  db: Kysely<Database>,
  logger: Logger,
  source: GithubReconcileSource,
  now: Date,
  nextId: () => string = randomUUID,
): Promise<void> {
  const repositories = await repositoriesOf(db);
  const runs = await lastRuns(db);
  const failures: unknown[] = [];
  for (const repository of repositories) {
    try {
      await reconcileOne(db, logger, source, repository, now, runs.get(repository.id) ?? null, nextId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (source.rateRemainingPercent !== undefined) {
    try {
      await observeGithubRate(db, logger, await source.rateRemainingPercent(now), now);
    } catch {
      // остаток лимита не отменяет уже записанную сверку
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('сверка зеркала не записана');
}

/**
 * Ход сверки раз в `RECONCILE_INTERVAL`.
 * Пока предыдущий ход не закончился, следующий не стартует.
 */
export function startReconcileLoop(
  run: (now: Date) => Promise<void>,
  clock: Clock,
  intervalMs: number,
  logger: Logger,
): { stop(): void } {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('интервал сверки');
  let busy = false;
  let stopped = false;
  const tick = (): void => {
    if (busy || stopped) return;
    busy = true;
    const startedAt = clock.now();
    const durationMs = (): number => clock.now().getTime() - startedAt.getTime();
    logger.info('reconcile.started');
    void run(startedAt).then(
      () => {
        busy = false;
        logger.info('reconcile.finished', { durationMs: durationMs() });
      },
      (error: unknown) => {
        busy = false;
        logger.error('reconcile.failed', { durationMs: durationMs() }, error);
      },
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
