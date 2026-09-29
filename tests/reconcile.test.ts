import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { RECONCILE_INTERVAL } from '../src/config/constants.ts';
import { CI_STATUS_FAILURE, CI_STATUS_SUCCESS } from '../src/domain/github/ci-status.ts';
import { githubWriteCommands } from '../src/domain/github/delivery.ts';
import {
  missedMirrorFacts,
  reconcileIdempotencyKey,
  reconcileIsDue,
  RECONCILE_FACT_COMMIT,
  RECONCILE_FACT_DEFAULT_BRANCH_CI,
  RECONCILE_FACT_ISSUE,
  RECONCILE_FACT_PULL_REQUEST,
  RECONCILE_FACT_PULL_REQUEST_CI,
  type GithubReconcileSource,
  type MirrorSnapshot,
  type RemoteMirror,
} from '../src/domain/github/reconcile.ts';
import { STALL_LINE_DEFAULT_BRANCH, repositoryStallFacts } from '../src/domain/github/stall.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_BLOCKED, TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { tasksFromGithub } from '../src/domain/tasks/github-origin.ts';
import { transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { githubReconcileRoutes, remoteMirrorFromApi, type GithubReconcileApi } from '../src/github/reconcile.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readBlockersMigration,
  readCiMirrorMigration,
  readCommitsMigration,
  readEventsMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { reconcileGithubMirror } from '../src/infrastructure/reconcile.ts';

const now = new Date('2026-09-28T07:33:00.000Z');
const repositoryId = '42';
const minuteMs = 60_000;
const projectId = '00000000-0000-4000-8000-0000000000a1';
const userId = '00000000-0000-4000-8000-0000000000c1';
const taskId = '00000000-0000-4000-8000-0000000000b1';

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

function reconcileSourceText(): string {
  return [
    'src/domain/github/reconcile.ts',
    'src/github/reconcile.ts',
    'src/infrastructure/reconcile.ts',
    ...filesIn('src/github'),
  ]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

function emptyMirror(): MirrorSnapshot {
  return { defaultBranchCi: null, issues: [], pullRequests: [], commits: [] };
}

function remote(patch: Partial<RemoteMirror> = {}): RemoteMirror {
  return { defaultBranch: 'main', defaultBranchCi: null, issues: [], pullRequests: [], commits: [], ...patch };
}

function issue(patch: Partial<RemoteMirror['issues'][number]> = {}): RemoteMirror['issues'][number] {
  return {
    number: 7,
    title: 'Дыра',
    state: 'open',
    stateReason: null,
    assignees: ['ada'],
    closedByLogin: null,
    updatedAt: '2026-09-28T07:00:00.000Z',
    ...patch,
  };
}

function countingSource(snapshot: RemoteMirror): { source: GithubReconcileSource; reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    source: {
      async read() {
        reads += 1;
        return snapshot;
      },
    },
  };
}

async function openMirror(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readIssueMirrorMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(readCommitsMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  await sql`
    INSERT INTO repositories (id, owner, name) VALUES (${repositoryId}, 'acme', 'bot')
  `.execute(db);
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${userId}::uuid, 1, 'Корень', true)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, repository_id, created_at)
    VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', ${repositoryId}, ${now.toISOString()}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
    VALUES (
      ${taskId}::uuid, ${projectId}::uuid, 1, 'Своя', ${TASK_STATUS_IN_PROGRESS}, 'normal',
      ${userId}::uuid, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
  `.execute(db);
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

describe('сверка пропущенной доставки', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('совпавший факт не догоняется, лишняя строка зеркала не снимается, хвост и свежий webhook держатся', () => {
    const known = issue();
    expect(missedMirrorFacts(repositoryId, { ...emptyMirror(), issues: [known] }, remote({ issues: [known] }), now)).toEqual([]);
    expect(missedMirrorFacts(repositoryId, { ...emptyMirror(), issues: [known] }, remote(), now)).toEqual([]);
    expect(
      missedMirrorFacts(
        repositoryId,
        { ...emptyMirror(), issues: [{ ...known, title: 'Уже новая', updatedAt: '2026-09-28T08:00:00.000Z' }] },
        remote({ issues: [known] }),
        now,
      ),
    ).toEqual([]);
    expect(missedMirrorFacts(repositoryId, { ...emptyMirror(), defaultBranchCi: CI_STATUS_FAILURE }, remote(), now)).toEqual([]);
    const outside = new Date(now.getTime() - 8 * 24 * 60 * minuteMs).toISOString();
    expect(
      missedMirrorFacts(
        repositoryId,
        emptyMirror(),
        remote({
          commits: [{ sha: 'abc', message: 'Старое', authorLogin: 'ada', createdAt: outside }],
        }),
        now,
      ),
    ).toEqual([]);
    const caught = missedMirrorFacts(repositoryId, emptyMirror(), remote({ issues: [known], defaultBranchCi: CI_STATUS_FAILURE }), now);
    expect(caught.map((fact) => fact.kind)).toEqual([RECONCILE_FACT_ISSUE, RECONCILE_FACT_DEFAULT_BRANCH_CI]);
    expect(reconcileIsDue(null, now)).toBe(true);
    expect(reconcileIsDue(new Date(now.getTime() - minuteMs), now)).toBe(false);
    expect(reconcileIsDue(new Date(now.getTime() - RECONCILE_INTERVAL * minuteMs), now)).toBe(true);
    expect(reconcileIdempotencyKey(repositoryId, now)).toBe(
      `${EVENT_TYPES.GITHUB_RECONCILED}+${repositoryId}+${now.toISOString()}`,
    );
  });

  it('INV-22 повтор того же прогона не пишет второе событие и не плодит строки зеркала', async () => {
    const handle = await openMirror();
    opened.push(handle);
    const inside = new Date(now.getTime() - 24 * 60 * minuteMs).toISOString();
    const snapshot = remote({
      issues: [issue()],
      pullRequests: [
        {
          number: 3,
          title: 'Черновик',
          authorLogin: 'ada',
          state: 'open',
          ciStatus: CI_STATUS_FAILURE,
          updatedAt: '2026-09-28T06:00:00.000Z',
          mergedAt: null,
          mergedByLogin: null,
          headBranch: 'feature',
        },
      ],
      commits: [{ sha: 'ABC', message: 'Сделано', authorLogin: 'ada', createdAt: inside }],
      defaultBranchCi: CI_STATUS_SUCCESS,
    });
    const probe = countingSource(snapshot);
    await reconcileGithubMirror(handle.db, probe.source, now);
    await reconcileGithubMirror(handle.db, probe.source, now);
    expect(probe.reads()).toBe(1);
    const events = await sql<{ event_type: string; restored: string; idempotency_key: string }>`
      SELECT event_type, payload->>'restored_facts' AS restored, idempotency_key
      FROM events
      ORDER BY created_at
    `.execute(handle.db);
    expect(events.rows).toEqual([
      {
        event_type: EVENT_TYPES.GITHUB_RECONCILED,
        restored: '5',
        idempotency_key: reconcileIdempotencyKey(repositoryId, now),
      },
    ]);
    const issues = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(handle.db);
    const pulls = await sql<{ n: number; ci_status: string | null }>`
      SELECT CAST(count(*) AS int) AS n, max(ci_status) AS ci_status FROM pull_requests
    `.execute(handle.db);
    const commits = await sql<{ sha: string }>`SELECT sha FROM commits`.execute(handle.db);
    expect(Number(issues.rows[0]?.n)).toBe(1);
    expect(pulls.rows).toEqual([{ n: 1, ci_status: CI_STATUS_FAILURE }]);
    expect(commits.rows).toEqual([{ sha: 'abc' }]);

    const later = new Date(now.getTime() + RECONCILE_INTERVAL * minuteMs);
    await reconcileGithubMirror(handle.db, probe.source, later);
    const after = await sql<{ event_type: string; restored: string }>`
      SELECT event_type, payload->>'restored_facts' AS restored FROM events ORDER BY created_at
    `.execute(handle.db);
    expect(after.rows).toEqual([
      { event_type: EVENT_TYPES.GITHUB_RECONCILED, restored: '5' },
      { event_type: EVENT_TYPES.GITHUB_RECONCILED, restored: '0' },
    ]);
    const issuesAfter = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(handle.db);
    expect(Number(issuesAfter.rows[0]?.n)).toBe(1);
    expect(probe.reads()).toBe(2);
  });

  it('INV-12 красный CI сверки не переводит задачу и не пишет блокер: строка выводится из зеркала', async () => {
    expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, EVENT_TYPES.GITHUB_RECONCILED)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    expect(tasksFromGithub([{ type: EVENT_TYPES.GITHUB_RECONCILED, payload: { repository_id: repositoryId, restored_facts: 1 } }])).toEqual(
      [],
    );
    const source = reconcileSourceText();
    expect(source).not.toContain('domain/tasks');
    expect(source).not.toContain('transitionTask');
    expect(source).not.toContain('TASK_STATUS_BLOCKED');
    const handle = await openMirror();
    opened.push(handle);
    await sql`
      INSERT INTO issues (id, repository_id, issue_number, title, state, updated_at)
      VALUES (
        '00000000-0000-4000-8000-0000000000e1'::uuid, ${repositoryId}, 9, 'Тихий', 'open', ${now.toISOString()}::timestamptz
      )
    `.execute(handle.db);
    const snapshot = remote({
      defaultBranchCi: CI_STATUS_FAILURE,
      issues: [issue({ number: 9, title: 'Тихий', assignees: [], updatedAt: now.toISOString() })],
    });
    await reconcileGithubMirror(handle.db, countingSource(snapshot).source, now);
    const task = await sql<{ status: string }>`SELECT status FROM tasks`.execute(handle.db);
    expect(task.rows).toEqual([{ status: TASK_STATUS_IN_PROGRESS }]);
    expect(task.rows[0]?.status).not.toBe(TASK_STATUS_BLOCKED);
    const blockers = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM blockers`.execute(handle.db);
    expect(Number(blockers.rows[0]?.n)).toBe(0);
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([EVENT_TYPES.GITHUB_RECONCILED]);
    const repository = await sql<{ default_branch_ci: string | null }>`
      SELECT default_branch_ci FROM repositories WHERE id = ${repositoryId}
    `.execute(handle.db);
    expect(repository.rows).toEqual([{ default_branch_ci: CI_STATUS_FAILURE }]);
    const lines = repositoryStallFacts({
      now,
      repositories: [{ repositoryId, defaultBranchCi: CI_STATUS_FAILURE }],
      projects: [{ projectId, repositoryId, timezone: 'Europe/Moscow' }],
      members: [],
      pullRequests: [],
    });
    expect(lines.lines).toEqual([{ kind: STALL_LINE_DEFAULT_BRANCH, projectId, repositoryId }]);
    expect(lines.notices).toEqual([]);
  });

  it('INV-21 сверка только читает GitHub и не заводит задачу', async () => {
    expect(githubWriteCommands()).toEqual([]);
    expect(githubReconcileRoutes().every((route) => route.startsWith('GET '))).toBe(true);
    const source = reconcileSourceText();
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
    expect(source).not.toContain('domain/tasks');
    const handle = await openMirror();
    opened.push(handle);
    await reconcileGithubMirror(handle.db, countingSource(remote()).source, now);
    const events = await sql<{ event_type: string; subject_entity: string }>`
      SELECT event_type, subject_entity FROM events
    `.execute(handle.db);
    expect(events.rows).toEqual([{ event_type: EVENT_TYPES.GITHUB_RECONCILED, subject_entity: 'Repository' }]);
    const tasks = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM tasks`.execute(handle.db);
    expect(Number(tasks.rows[0]?.n)).toBe(1);
  });

  it('короче интервала GitHub не читается, ошибка чтения событие не пишет', async () => {
    const handle = await openMirror();
    opened.push(handle);
    const probe = countingSource(remote());
    await reconcileGithubMirror(handle.db, probe.source, now);
    const early = new Date(now.getTime() + minuteMs);
    await reconcileGithubMirror(handle.db, probe.source, early);
    expect(probe.reads()).toBe(1);
    const failing: GithubReconcileSource = {
      async read() {
        throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'лимит');
      },
    };
    const due = new Date(now.getTime() + RECONCILE_INTERVAL * minuteMs);
    await expect(reconcileGithubMirror(handle.db, failing, due)).rejects.toThrow(DomainError);
    const events = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM events`.execute(handle.db);
    expect(Number(events.rows[0]?.n)).toBe(1);
  });

  it('снимок API пропускает pull request в списке issues и коммит без логина', async () => {
    const api: GithubReconcileApi = {
      async issues() {
        return [
          { number: 4, title: 'Дело', state: 'closed', state_reason: 'completed', assignees: [{ login: 'ada' }], closed_by: { login: 'meg' }, updated_at: now.toISOString() },
          { number: 5, title: 'Это PR', state: 'open', updated_at: now.toISOString(), pull_request: { url: 'x' } },
        ];
      },
      async pullRequests() {
        return [
          {
            number: 5,
            title: 'Это PR',
            state: 'closed',
            merged: true,
            user: { login: 'ada' },
            updated_at: now.toISOString(),
            merged_at: now.toISOString(),
            merged_by: { login: 'meg' },
            head: { ref: 'feature', sha: 'abc' },
          },
        ];
      },
      async commits() {
        return [
          { sha: 'aaa', commit: { message: 'Есть автор', author: { date: now.toISOString() } }, author: { login: 'ada' } },
          { sha: 'bbb', commit: { message: 'Без логина', author: { date: now.toISOString() } }, author: null },
        ];
      },
      async latestConclusion(_owner, _repo, selector) {
        if ('branch' in selector) return 'failure';
        return 'success';
      },
    };
    const snapshot = await remoteMirrorFromApi(api, { owner: 'acme', name: 'bot', defaultBranch: 'main' }, now);
    expect(snapshot.issues.map((item) => item.number)).toEqual([4]);
    expect(snapshot.pullRequests).toMatchObject([{ number: 5, state: 'merged', ciStatus: CI_STATUS_SUCCESS, headBranch: 'feature' }]);
    expect(snapshot.commits.map((item) => item.sha)).toEqual(['aaa']);
    expect(snapshot.defaultBranchCi).toBe(CI_STATUS_FAILURE);
    const missed = missedMirrorFacts(repositoryId, emptyMirror(), snapshot, now);
    expect(missed.map((fact) => fact.kind)).toEqual([
      RECONCILE_FACT_ISSUE,
      RECONCILE_FACT_PULL_REQUEST,
      RECONCILE_FACT_PULL_REQUEST_CI,
      RECONCILE_FACT_COMMIT,
      RECONCILE_FACT_DEFAULT_BRANCH_CI,
    ]);
  });
});
