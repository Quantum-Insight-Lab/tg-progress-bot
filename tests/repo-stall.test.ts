import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_DAYS } from '../src/config/constants.ts';
import { CI_STATUS_CANCELLED, CI_STATUS_FAILURE, CI_STATUS_OTHER, CI_STATUS_SUCCESS } from '../src/domain/github/ci-status.ts';
import { githubWriteCommands } from '../src/domain/github/delivery.ts';
import { PULL_REQUEST_STATE_CLOSED, PULL_REQUEST_STATE_OPEN } from '../src/domain/github/pull-request.ts';
import {
  PR_STALL_NOTICE_ZONE,
  STALL_LINE_DEFAULT_BRANCH,
  STALL_LINE_PULL_REQUEST,
  prStalledKey,
  repositoryStallFacts,
  type StallFacts,
  type StallInput,
  type StallLine,
  type StallPullRequest,
} from '../src/domain/github/stall.ts';
import { projectCalendarDate, projectDaysBetween } from '../src/domain/shared/project-time.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readBlockersMigration,
  readCiMirrorMigration,
  readEventsMigration,
  readIssueDependenciesMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { noticeStalePullRequests, readRepositoryStall } from '../src/infrastructure/pr-stall.ts';
import { silentLogger } from './log-lines.ts';

const repositoryId = '42';
const now = new Date('2026-09-27T22:00:00.000Z');
const idleSince = new Date('2026-09-26T20:00:00.000Z');
const freshAt = new Date('2026-09-27T22:00:00.000Z');
const recentAt = new Date('2026-09-26T22:00:00.000Z');
const projectMoscow = '00000000-0000-4000-8000-0000000000a1';
const projectUtc = '00000000-0000-4000-8000-0000000000a2';
const userAda = '00000000-0000-4000-8000-0000000000b1';
const pullAda = '00000000-0000-4000-8000-0000000000d1';
const pullStranger = '00000000-0000-4000-8000-0000000000d2';
const pullFresh = '00000000-0000-4000-8000-0000000000d3';
const pullClosed = '00000000-0000-4000-8000-0000000000d4';
const taskId = '00000000-0000-4000-8000-0000000000e1';
const issueQuiet = '00000000-0000-4000-8000-0000000000f1';
const issueOther = '00000000-0000-4000-8000-0000000000f2';
const memberMoscow = '00000000-0000-4000-8000-0000000000c1';
const memberUtc = '00000000-0000-4000-8000-0000000000c2';
const quietIssueNumber = 15;

const WRITE_CALLS = [
  'issues.create',
  'issues.update',
  'issues.createComment',
  'pulls.create',
  'pulls.merge',
  'repos.createCommit',
  "method: 'POST'",
  "method: 'PATCH'",
  "method: 'PUT'",
  "method: 'DELETE'",
];

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function mirror(patch: Partial<StallInput> = {}): StallInput {
  return {
    now,
    repositories: [{ repositoryId, defaultBranchCi: CI_STATUS_FAILURE }],
    projects: [
      { projectId: projectMoscow, repositoryId, timezone: 'Europe/Moscow' },
      { projectId: projectUtc, repositoryId, timezone: 'UTC' },
    ],
    members: [
      { projectId: projectMoscow, githubLogin: 'ada' },
      { projectId: projectUtc, githubLogin: 'ada' },
    ],
    pullRequests: [
      {
        id: pullAda,
        repositoryId,
        pullRequestNumber: 7,
        authorLogin: 'ada',
        state: PULL_REQUEST_STATE_OPEN,
        ciStatus: CI_STATUS_FAILURE,
        updatedAt: idleSince,
      },
    ],
    ...patch,
  };
}

function pullLines(facts: StallFacts, projectId: string): StallLine[] {
  return facts.lines.filter((line) => line.kind === STALL_LINE_PULL_REQUEST && line.projectId === projectId);
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readIssueMirrorMigration());
  await pglite.exec(readIssueDependenciesMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
  return { db, close: () => db.destroy() };
}

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root, github_login)
    VALUES (${userAda}::uuid, 1001, 'Ада', true, 'ada')
  `.execute(db);
  await sql`
    INSERT INTO repositories (id, owner, name, default_branch_ci)
    VALUES (${repositoryId}, 'acme', 'app', ${CI_STATUS_FAILURE})
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at, repository_id)
    VALUES
      (${projectMoscow}::uuid, 'Москва', '', 'Europe/Moscow', null, ${now}, ${repositoryId}),
      (${projectUtc}::uuid, 'UTC', '', 'UTC', null, ${now}, ${repositoryId})
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES
      (${memberMoscow}::uuid, ${projectMoscow}::uuid, ${userAda}::uuid, 'member'),
      (${memberUtc}::uuid, ${projectUtc}::uuid, ${userAda}::uuid, 'member')
  `.execute(db);
  await sql`
    INSERT INTO tasks (
      id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at
    )
    VALUES (
      ${taskId}::uuid, ${projectMoscow}::uuid, 7, 'Своя', ${TASK_STATUS_IN_PROGRESS}, 'normal',
      ${userAda}::uuid, ${now}, ${now}, null
    )
  `.execute(db);
  await sql`
    INSERT INTO issues (
      id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
    )
    VALUES
      (${issueQuiet}::uuid, ${repositoryId}, ${quietIssueNumber}, 'Тихий', 'open', null, null, ${now}, null),
      (${issueOther}::uuid, ${repositoryId}, 16, 'Сосед', 'open', null, null, ${now}, null)
  `.execute(db);
  await sql`
    INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, link_type)
    VALUES (${issueQuiet}::uuid, ${issueOther}::uuid, 'blocked_by')
  `.execute(db);
  await sql`
    INSERT INTO pull_requests (
      id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at, merged_at, merged_by_login
    )
    VALUES
      (${pullAda}::uuid, ${repositoryId}, 7, 'Черновик', 'ada', ${PULL_REQUEST_STATE_OPEN}, ${CI_STATUS_FAILURE}, ${idleSince}, null, null),
      (${pullStranger}::uuid, ${repositoryId}, 8, 'Чужой', 'stranger', ${PULL_REQUEST_STATE_OPEN}, ${CI_STATUS_FAILURE}, ${idleSince}, null, null),
      (${pullFresh}::uuid, ${repositoryId}, 9, 'Свежий', 'ada', ${PULL_REQUEST_STATE_OPEN}, ${CI_STATUS_FAILURE}, ${freshAt}, null, null),
      (${pullClosed}::uuid, ${repositoryId}, 10, 'Закрыт', 'ada', ${PULL_REQUEST_STATE_CLOSED}, ${CI_STATUS_FAILURE}, ${idleSince}, null, null)
  `.execute(db);
}

async function taskStatus(db: Kysely<Database>): Promise<string> {
  const found = await sql<{ status: string }>`SELECT status FROM tasks WHERE id = ${taskId}::uuid`.execute(db);
  const row = found.rows[0];
  if (row === undefined) throw new Error('задача не найдена');
  return row.status;
}

async function blockerCount(db: Kysely<Database>): Promise<number> {
  const found = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM blockers`.execute(db);
  return Number(found.rows[0]?.n ?? 0);
}

async function stallEvents(db: Kysely<Database>): Promise<{ key: string; payload: Record<string, unknown> }[]> {
  const found = await sql<{ idempotency_key: string; payload: unknown }>`
    SELECT idempotency_key, payload FROM events WHERE event_type = ${EVENT_TYPES.REPO_PR_STALLED}
    ORDER BY created_at, idempotency_key
  `.execute(db);
  return found.rows.map((row) => ({
    key: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown>),
  }));
}

describe('застой репозитория', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-12 красный CI — строка на каждом проекте; у застрявшего PR красный CI — та же строка; неизвестный CI не блокер', () => {
    const facts = repositoryStallFacts(mirror({
      repositories: [
        { repositoryId, defaultBranchCi: CI_STATUS_FAILURE },
        { repositoryId: '7', defaultBranchCi: null },
        { repositoryId: '8', defaultBranchCi: CI_STATUS_SUCCESS },
        { repositoryId: '9', defaultBranchCi: CI_STATUS_CANCELLED },
        { repositoryId: '11', defaultBranchCi: CI_STATUS_OTHER },
      ],
      projects: [
        { projectId: projectMoscow, repositoryId, timezone: 'UTC' },
        { projectId: projectUtc, repositoryId, timezone: 'UTC' },
        { projectId: '00000000-0000-4000-8000-0000000000a3', repositoryId: '7', timezone: 'UTC' },
        { projectId: '00000000-0000-4000-8000-0000000000a4', repositoryId: null, timezone: 'UTC' },
      ],
      pullRequests: [
        {
          id: pullAda,
          repositoryId,
          pullRequestNumber: 7,
          authorLogin: 'ada',
          state: PULL_REQUEST_STATE_OPEN,
          ciStatus: CI_STATUS_FAILURE,
          updatedAt: new Date('2026-09-25T22:00:00.000Z'),
        },
      ],
    }));
    const defaults = facts.lines.filter((line) => line.kind === STALL_LINE_DEFAULT_BRANCH);
    expect(defaults).toEqual([
      { kind: STALL_LINE_DEFAULT_BRANCH, projectId: projectMoscow, repositoryId },
      { kind: STALL_LINE_DEFAULT_BRANCH, projectId: projectUtc, repositoryId },
    ]);
    expect(pullLines(facts, projectMoscow)).toEqual([
      {
        kind: STALL_LINE_PULL_REQUEST,
        projectId: projectMoscow,
        repositoryId,
        pullRequestNumber: 7,
        authorLogin: 'ada',
        ciRed: true,
      },
    ]);
    expect(pullLines(facts, projectUtc)).toHaveLength(1);
    for (const line of facts.lines) {
      expect(line).not.toHaveProperty('taskNumber');
      expect(line).not.toHaveProperty('taskId');
      expect(line).not.toHaveProperty('issueNumber');
    }
    expect(JSON.stringify(facts)).not.toContain(String(quietIssueNumber));
  });

  it('INV-13 PR чужого логина не виден ни одному проекту, автор в зеркале остаётся', () => {
    const stranger: StallPullRequest = {
      id: pullStranger,
      repositoryId,
      pullRequestNumber: 8,
      authorLogin: 'stranger',
      state: PULL_REQUEST_STATE_OPEN,
      ciStatus: CI_STATUS_FAILURE,
      updatedAt: idleSince,
    };
    const facts = repositoryStallFacts(mirror({
      members: [{ projectId: projectMoscow, githubLogin: 'Ada' }],
      pullRequests: [
        {
          id: pullAda,
          repositoryId,
          pullRequestNumber: 7,
          authorLogin: 'ada',
          state: PULL_REQUEST_STATE_OPEN,
          ciStatus: CI_STATUS_FAILURE,
          updatedAt: idleSince,
        },
        stranger,
      ],
    }));
    expect(pullLines(facts, projectMoscow).map((line) => line.kind === STALL_LINE_PULL_REQUEST ? line.authorLogin : '')).toEqual(['ada']);
    expect(pullLines(facts, projectUtc)).toEqual([]);
    expect(facts.lines.some((line) => line.kind === STALL_LINE_PULL_REQUEST && line.pullRequestNumber === 8)).toBe(false);
    expect(stranger.authorLogin).toBe('stranger');
    expect(facts.notices.map((notice) => notice.pullRequestNumber)).toEqual([7]);
  });

  it('INV-10 порог PR — STALE_DAYS по таймзоне проекта, как у галочки', () => {
    const short = repositoryStallFacts(mirror({
      pullRequests: [
        {
          id: pullFresh,
          repositoryId,
          pullRequestNumber: 9,
          authorLogin: 'ada',
          state: PULL_REQUEST_STATE_OPEN,
          ciStatus: null,
          updatedAt: recentAt,
        },
      ],
    }));
    expect(short.lines.filter((line) => line.kind === STALL_LINE_PULL_REQUEST)).toEqual([]);
    expect(short.notices).toEqual([]);
    expect(projectDaysBetween(recentAt, now, 'Europe/Moscow')).toBe(STALE_DAYS - 1);

    const facts = repositoryStallFacts(mirror());
    expect(projectDaysBetween(idleSince, now, 'Europe/Moscow')).toBe(STALE_DAYS);
    expect(projectDaysBetween(idleSince, now, 'UTC')).toBe(STALE_DAYS - 1);
    expect(pullLines(facts, projectMoscow)).toEqual([
      {
        kind: STALL_LINE_PULL_REQUEST,
        projectId: projectMoscow,
        repositoryId,
        pullRequestNumber: 7,
        authorLogin: 'ada',
        ciRed: true,
      },
    ]);
    expect(pullLines(facts, projectUtc)).toEqual([]);
    const date = projectCalendarDate(now, PR_STALL_NOTICE_ZONE);
    expect(facts.notices).toEqual([
      {
        repositoryId,
        pullRequestNumber: 7,
        pullRequestId: pullAda,
        authorLogin: 'ada',
        days: STALE_DAYS,
        date,
        idempotencyKey: prStalledKey(repositoryId, 7, date),
      },
    ]);
  });

  it('INV-12 красный CI и тихий issue не переводят задачу в BLOCKED и не ссылаются на её номер', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const before = await taskStatus(handle.db);
    const facts = await readRepositoryStall(handle.db, now);
    await noticeStalePullRequests(handle.db, silentLogger, now);
    expect(before).toBe(TASK_STATUS_IN_PROGRESS);
    expect(await taskStatus(handle.db)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(await blockerCount(handle.db)).toBe(0);
    expect(facts.lines.filter((line) => line.kind === STALL_LINE_DEFAULT_BRANCH)).toEqual([
      { kind: STALL_LINE_DEFAULT_BRANCH, projectId: projectMoscow, repositoryId },
      { kind: STALL_LINE_DEFAULT_BRANCH, projectId: projectUtc, repositoryId },
    ]);
    expect(facts.lines.filter((line) => line.kind === STALL_LINE_PULL_REQUEST)).toEqual([
      {
        kind: STALL_LINE_PULL_REQUEST,
        projectId: projectMoscow,
        repositoryId,
        pullRequestNumber: 7,
        authorLogin: 'ada',
        ciRed: true,
      },
    ]);
    for (const line of facts.lines) {
      expect(line).not.toHaveProperty('taskNumber');
      expect(line).not.toHaveProperty('issueNumber');
    }
    const events = await stallEvents(handle.db);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      repository_id: repositoryId,
      pull_request_number: 7,
      author_login: 'ada',
      days: STALE_DAYS,
    });
    expect(events[0]?.payload).not.toHaveProperty('task_id');
    expect(events[0]?.key).toBe(prStalledKey(repositoryId, 7, projectCalendarDate(now, PR_STALL_NOTICE_ZONE)));
  });

  it('INV-21 запись застоя не пишет в GitHub и не заводит задачу', () => {
    const source = [join('src', 'domain', 'github', 'stall.ts'), join('src', 'infrastructure', 'pr-stall.ts'), ...filesIn(join('src', 'github'))]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const call of WRITE_CALLS) expect(source).not.toContain(call);
    expect(githubWriteCommands()).toEqual([]);
    expect(readFileSync(join('src', 'infrastructure', 'pr-stall.ts'), 'utf8')).not.toContain('UPDATE tasks');
    expect(readFileSync(join('src', 'infrastructure', 'pr-stall.ts'), 'utf8')).not.toContain('blockers');
  });

  it('INV-22 повтор хода не пишет второе repo.pr_stalled', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    await noticeStalePullRequests(handle.db, silentLogger, now);
    await noticeStalePullRequests(handle.db, silentLogger, now);
    expect(await stallEvents(handle.db)).toHaveLength(1);
    expect(await taskStatus(handle.db)).toBe(TASK_STATUS_IN_PROGRESS);
    expect(await blockerCount(handle.db)).toBe(0);
  });
});
