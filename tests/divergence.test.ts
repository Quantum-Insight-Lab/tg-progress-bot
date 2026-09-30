import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closedProjectDate,
  divergenceDetectedKey,
  dueDivergence,
  previousCalendarDate,
  projectDiverges,
  type DivergenceCommit,
  type DivergenceIssue,
  type DivergenceMember,
  type DivergenceProject,
  type DivergencePullRequest,
  type DivergenceTask,
} from '../src/domain/progress/divergence.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { noticeProjectDivergence } from '../src/infrastructure/divergence.ts';
import {
  readBlockersMigration,
  readCiMirrorMigration,
  readCommitsMigration,
  readEventsMigration,
  readIssuesMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createScheduler } from '../src/infrastructure/scheduler.ts';
import { silentLogger } from './log-lines.ts';

const repo = '42';
const otherRepo = '7';
const alphaId = '00000000-0000-4000-8000-0000000000a1';
const betaId = '00000000-0000-4000-8000-0000000000a2';
const utcId = '00000000-0000-4000-8000-0000000000a3';
const bareId = '00000000-0000-4000-8000-0000000000a4';
const adaId = '00000000-0000-4000-8000-0000000000b1';
const graceId = '00000000-0000-4000-8000-0000000000b2';
const taskId = '00000000-0000-4000-8000-0000000000c1';
const blockerId = '00000000-0000-4000-8000-0000000000d1';
const memberAda = '00000000-0000-4000-8000-0000000000e1';
const memberGrace = '00000000-0000-4000-8000-0000000000e2';
const memberUtc = '00000000-0000-4000-8000-0000000000e3';

const now = new Date('2026-09-29T00:30:00.000Z');
const closedMoscow = '2026-09-28';
const duringClosedDay = new Date('2026-09-28T20:00:00.000Z');
const stillOpenInMoscow = new Date('2026-09-28T22:00:00.000Z');
const weekBefore = new Date('2026-09-20T12:00:00.000Z');

const moscow: DivergenceProject = { projectId: alphaId, timezone: 'Europe/Moscow', repositoryId: repo };
const sibling: DivergenceProject = { projectId: betaId, timezone: 'Europe/Moscow', repositoryId: repo };
const utc: DivergenceProject = { projectId: utcId, timezone: 'UTC', repositoryId: repo };
const bare: DivergenceProject = { projectId: bareId, timezone: 'Europe/Moscow', repositoryId: null };

function member(projectId: string, githubLogin: string | null): DivergenceMember {
  return { projectId, githubLogin };
}

function commit(authorLogin: string, createdAt: Date, repositoryId = repo): DivergenceCommit {
  return { repositoryId, authorLogin, createdAt };
}

function pullRequest(
  state: string,
  authorLogin: string,
  mergedAt: Date | null,
  repositoryId = repo,
): DivergencePullRequest {
  return { repositoryId, state, authorLogin, mergedAt };
}

function issue(
  state: string,
  closedByLogin: string | null,
  closedAt: Date | null,
  repositoryId = repo,
): DivergenceIssue {
  return { repositoryId, state, closedByLogin, closedAt };
}

function task(projectId: string, createdAt: Date, completedAt: Date | null = null): DivergenceTask {
  return { projectId, createdAt, completedAt };
}

function day(input: {
  project?: DivergenceProject;
  date?: string;
  members?: readonly DivergenceMember[];
  commits?: readonly DivergenceCommit[];
  pullRequests?: readonly DivergencePullRequest[];
  issues?: readonly DivergenceIssue[];
  tasks?: readonly DivergenceTask[];
}): boolean {
  return projectDiverges({
    project: input.project ?? moscow,
    date: input.date ?? closedMoscow,
    members: input.members ?? [member(alphaId, 'ada')],
    commits: input.commits ?? [],
    pullRequests: input.pullRequests ?? [],
    issues: input.issues ?? [],
    tasks: input.tasks ?? [],
  });
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

interface StoredTask {
  status: string;
  updated_at: Date | string;
}

interface StoredBlocker {
  id: string;
  reason: string | null;
  resolved_at: Date | string | null;
}

interface StoredEvent {
  key: string;
  payload: unknown;
  subject_id: string;
  subject_entity: string;
}

function payloadOf(value: unknown): { project_id?: string; date?: string } {
  if (typeof value === 'string') return JSON.parse(value) as { project_id?: string; date?: string };
  if (value !== null && typeof value === 'object') return value as { project_id?: string; date?: string };
  return {};
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(readCommitsMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root, github_login)
    VALUES
      (${adaId}::uuid, 1, 'Ада', true, 'ada'),
      (${graceId}::uuid, 2, 'Грейс', false, 'grace')
  `.execute(db);
  await sql`
    INSERT INTO repositories (id, owner, name, default_branch_ci)
    VALUES (${repo}, 'lab', 'bot', 'failure'), (${otherRepo}, 'lab', 'other', 'failure')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
    VALUES
      (${alphaId}::uuid, 'Альфа', '', 'Europe/Moscow', ${weekBefore.toISOString()}::timestamptz, ${repo}),
      (${betaId}::uuid, 'Бета', '', 'Europe/Moscow', ${weekBefore.toISOString()}::timestamptz, ${repo}),
      (${utcId}::uuid, 'Ютс', '', 'UTC', ${weekBefore.toISOString()}::timestamptz, ${repo}),
      (${bareId}::uuid, 'Без репозитория', '', 'Europe/Moscow', ${weekBefore.toISOString()}::timestamptz, NULL)
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES
      (${memberAda}::uuid, ${alphaId}::uuid, ${adaId}::uuid, 'member'),
      (${memberGrace}::uuid, ${betaId}::uuid, ${graceId}::uuid, 'member'),
      (${memberUtc}::uuid, ${utcId}::uuid, ${adaId}::uuid, 'lead')
  `.execute(db);
  await sql`
    INSERT INTO tasks (
      id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at
    )
    VALUES (
      ${taskId}::uuid,
      ${alphaId}::uuid,
      1,
      'идёт',
      'IN_PROGRESS',
      'normal',
      ${adaId}::uuid,
      ${weekBefore.toISOString()}::timestamptz,
      ${weekBefore.toISOString()}::timestamptz,
      NULL
    )
  `.execute(db);
  await sql`
    INSERT INTO blockers (id, task_id, reason, asked_at, resolved_at)
    VALUES (${blockerId}::uuid, ${taskId}::uuid, 'жду', ${weekBefore.toISOString()}::timestamptz, NULL)
  `.execute(db);
}

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const found = await sql<StoredTask>`
    SELECT status, updated_at FROM tasks ORDER BY id
  `.execute(db);
  return found.rows;
}

async function blockersOf(db: Kysely<Database>): Promise<StoredBlocker[]> {
  const found = await sql<StoredBlocker>`
    SELECT id::text AS id, reason, resolved_at FROM blockers ORDER BY id
  `.execute(db);
  return found.rows;
}

async function eventsOf(db: Kysely<Database>): Promise<StoredEvent[]> {
  const found = await sql<StoredEvent>`
    SELECT idempotency_key AS key, payload, subject_id, subject_entity
    FROM events
    WHERE event_type = ${EVENT_TYPES.DIVERGENCE_DETECTED}
    ORDER BY idempotency_key
  `.execute(db);
  return found.rows;
}

describe('сигнал расхождения за сутки', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-15 сигнал проектный: чужая команда в том же репозитории его не зажигает', () => {
    const graceCommit = [commit('grace', duringClosedDay)];
    const members = [member(alphaId, 'ada'), member(betaId, 'grace'), member(utcId, 'ada')];
    expect(day({ members, commits: graceCommit })).toBe(false);
    expect(day({ project: sibling, members, commits: graceCommit })).toBe(true);
    expect(day({ project: sibling, members, commits: [commit('grace', duringClosedDay, otherRepo)] })).toBe(false);
    expect(day({ project: bare, members, commits: graceCommit })).toBe(false);
    expect(day({ members, commits: [commit('former', duringClosedDay)] })).toBe(false);
    expect(day({ members: [member(alphaId, 'Ada')], commits: [commit('ada', duringClosedDay)] })).toBe(true);
    const both = dueDivergence({
      now,
      projects: [moscow, sibling, moscow],
      members,
      commits: graceCommit,
      pullRequests: [],
      issues: [],
      tasks: [],
      takenKeys: new Set(),
    });
    expect(both.map((item) => item.projectId)).toEqual([betaId]);
    expect(both[0]?.date).toBe(closedMoscow);
  });

  it('INV-15 сигнал за календарные сутки проекта, текущий день ещё не закрыт', () => {
    expect(previousCalendarDate('2024-03-01')).toBe('2024-02-29');
    expect(previousCalendarDate('2025-03-01')).toBe('2025-02-28');
    expect(previousCalendarDate('1900-03-01')).toBe('1900-02-28');
    expect(previousCalendarDate('2000-03-01')).toBe('2000-02-29');
    expect(previousCalendarDate('2026-01-01')).toBe('2025-12-31');
    expect(closedProjectDate(now, 'Europe/Moscow')).toBe(closedMoscow);
    expect(closedProjectDate(now, 'UTC')).toBe(closedMoscow);
    expect(() => previousCalendarDate('2026-02-31')).toThrow(DomainError);
    expect(() => previousCalendarDate('2026-02-31')).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.DIVERGENCE_DATE }),
    );

    const late = [commit('ada', stillOpenInMoscow)];
    const members = [member(alphaId, 'ada'), member(utcId, 'ada')];
    expect(day({ date: closedMoscow, members, commits: late })).toBe(false);
    expect(day({ project: utc, date: closedMoscow, members, commits: late })).toBe(true);
    expect(
      dueDivergence({
        now,
        projects: [moscow, utc],
        members,
        commits: late,
        pullRequests: [],
        issues: [],
        tasks: [],
        takenKeys: new Set(),
      }).map((item) => item.projectId),
    ).toEqual([utcId]);
    expect(
      dueDivergence({
        now: new Date('2026-09-28T18:00:00.000Z'),
        projects: [moscow],
        members,
        commits: [commit('ada', duringClosedDay)],
        pullRequests: [],
        issues: [],
        tasks: [],
        takenKeys: new Set(),
      }),
    ).toEqual([]);
  });

  it('INV-15 сигнал горит только когда движение участника и тишина в задачах случились вместе', () => {
    const moved = [commit('ada', duringClosedDay)];
    const members = [member(alphaId, 'ada')];
    expect(day({ members })).toBe(false);
    expect(day({ members, commits: moved, tasks: [task(alphaId, weekBefore)] })).toBe(true);
    expect(day({ members, commits: moved, tasks: [task(betaId, duringClosedDay)] })).toBe(true);
    expect(day({ members, tasks: [task(alphaId, weekBefore)] })).toBe(false);
    expect(day({ members, commits: moved, tasks: [task(alphaId, duringClosedDay)] })).toBe(false);
    expect(day({ members, commits: moved, tasks: [task(alphaId, weekBefore, duringClosedDay)] })).toBe(false);
    expect(day({ members, commits: moved, tasks: [task(alphaId, weekBefore, weekBefore)] })).toBe(true);
  });

  it('INV-15 движение — коммит, смерженный PR или закрытый issue участника; красный CI и закрытый без слияния PR — нет', () => {
    const members = [member(alphaId, 'ada')];
    expect(day({ members, commits: [commit('ada', duringClosedDay)] })).toBe(true);
    expect(day({ members, pullRequests: [pullRequest('merged', 'ada', duringClosedDay)] })).toBe(true);
    expect(day({ members, pullRequests: [pullRequest('merged', 'bot', duringClosedDay)] })).toBe(false);
    expect(day({ members, pullRequests: [pullRequest('closed', 'ada', null)] })).toBe(false);
    expect(day({ members, pullRequests: [pullRequest('open', 'ada', null)] })).toBe(false);
    expect(day({ members, issues: [issue('closed', 'ada', duringClosedDay)] })).toBe(true);
    expect(day({ members, issues: [issue('closed', 'outsider', duringClosedDay)] })).toBe(false);
    expect(day({ members, issues: [issue('open', null, null)] })).toBe(false);
    expect(day({ members, issues: [issue('closed', 'ada', null)] })).toBe(false);
    expect(day({ members })).toBe(false);
    expect(() => day({ members, pullRequests: [pullRequest('draft', 'ada', duringClosedDay)] })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.DIVERGENCE_FACT }),
    );
  });

  it('INV-15 сигнал не меняет статусы задач и не создаёт блокер', async () => {
    const quiet = task(alphaId, weekBefore);
    const facts = {
      now,
      projects: [moscow],
      members: [member(alphaId, 'ada')],
      commits: [commit('ada', duringClosedDay)],
      pullRequests: [],
      issues: [],
      tasks: [quiet],
      takenKeys: new Set<string>(),
    };
    expect(dueDivergence(facts)).toEqual([
      {
        projectId: alphaId,
        date: closedMoscow,
        idempotencyKey: divergenceDetectedKey(alphaId, closedMoscow),
      },
    ]);
    expect(quiet).toEqual(task(alphaId, weekBefore));

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const beforeTasks = await tasksOf(handle.db);
    const beforeBlockers = await blockersOf(handle.db);
    await sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES (
        '00000000-0000-4000-8000-0000000000f1'::uuid,
        ${repo},
        'abc',
        'правка',
        'ada',
        ${duringClosedDay.toISOString()}::timestamptz
      )
    `.execute(handle.db);
    await noticeProjectDivergence(handle.db, silentLogger, now);
    expect(await tasksOf(handle.db)).toEqual(beforeTasks);
    expect(await blockersOf(handle.db)).toEqual(beforeBlockers);
    const factsWritten = await eventsOf(handle.db);
    expect(factsWritten.map((item) => payloadOf(item.payload))).toEqual([
      { project_id: alphaId, date: closedMoscow },
      { project_id: utcId, date: closedMoscow },
    ]);
    expect(factsWritten.every((item) => item.subject_entity === 'Project')).toBe(true);
    expect(factsWritten.map((item) => item.subject_id)).toEqual([alphaId, utcId]);
    const source = [join('src', 'domain', 'progress', 'divergence.ts'), join('src', 'infrastructure', 'divergence.ts')]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(source).not.toContain('UPDATE tasks');
    expect(source).not.toContain('INSERT INTO tasks');
    expect(source).not.toContain('INSERT INTO blockers');
    expect(source).not.toContain('default_branch_ci');
  });

  it('INV-22 повтор закрытых суток не пишет второй сигнал расхождения', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    await sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES (
        '00000000-0000-4000-8000-0000000000f2'::uuid,
        ${repo},
        'def',
        'ещё',
        'grace',
        ${duringClosedDay.toISOString()}::timestamptz
      )
    `.execute(handle.db);
    await sql`
      INSERT INTO pull_requests (
        id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at, merged_at, merged_by_login
      )
      VALUES (
        '00000000-0000-4000-8000-0000000000f3'::uuid,
        ${repo},
        4,
        'слияние',
        'ada',
        'merged',
        'failure',
        ${duringClosedDay.toISOString()}::timestamptz,
        ${duringClosedDay.toISOString()}::timestamptz,
        'bot'
      )
    `.execute(handle.db);
    await sql`
      INSERT INTO issues (
        id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
      )
      VALUES (
        '00000000-0000-4000-8000-0000000000f4'::uuid,
        ${repo},
        9,
        'закрыт',
        'closed',
        'not_planned',
        'ada',
        ${duringClosedDay.toISOString()}::timestamptz,
        ${duringClosedDay.toISOString()}::timestamptz
      )
    `.execute(handle.db);
    const clock: Clock = { now: () => now };
    const scheduler = createScheduler(clock);
    scheduler.register('A-36', (at) => noticeProjectDivergence(handle.db, silentLogger, at));
    await scheduler.run();
    const once = await eventsOf(handle.db);
    expect(once.map((item) => item.key).sort()).toEqual(
      [divergenceDetectedKey(alphaId, closedMoscow), divergenceDetectedKey(betaId, closedMoscow), divergenceDetectedKey(utcId, closedMoscow)].sort(),
    );
    await scheduler.run();
    await noticeProjectDivergence(handle.db, silentLogger, now);
    expect(await eventsOf(handle.db)).toEqual(once);
    expect(await tasksOf(handle.db)).toEqual([
      { status: 'IN_PROGRESS', updated_at: new Date(weekBefore.toISOString()) },
    ]);
  });
});
