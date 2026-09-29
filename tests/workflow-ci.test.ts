import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { ciBranch, ciStatus, workflowConclusion } from '../src/domain/github/ci-status.ts';
import {
  githubWriteCommands,
  recordGithubDelivery,
  type GithubDelivery,
  type PullRequestDelivery,
} from '../src/domain/github/delivery.ts';
import { definePullRequest, PULL_REQUEST_STATE_MERGED, PULL_REQUEST_STATE_OPEN } from '../src/domain/github/pull-request.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createInstallationRepositories } from '../src/infrastructure/installation-repositories.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import {
  readCiMirrorMigration,
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readProjectRepositoryMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { mirrorGithubPullRequest } from '../src/infrastructure/pull-request-mirror.ts';
import { mirrorGithubWorkflow } from '../src/infrastructure/workflow-mirror.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const repositoryId = '42';
const updatedAt = '2026-09-28T07:33:00Z';
const mergedAt = '2026-09-28T08:00:00Z';
const secret = 'hook-secret';
const rootId = '00000000-0000-4000-8000-0000000000c1';

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

function sourceOf(paths: string[]): string {
  return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
}

function mirrorSource(): string {
  return sourceOf([
    ...filesIn('src/github'),
    'src/domain/github/ci-status.ts',
    'src/domain/github/workflow-mirror.ts',
    'src/domain/github/pull-request.ts',
    'src/domain/github/pull-request-mirror.ts',
    'src/infrastructure/workflow-mirror.ts',
    'src/infrastructure/pull-request-mirror.ts',
  ]);
}

function pullRequestDelivery(patch: Partial<PullRequestDelivery> = {}): PullRequestDelivery {
  return {
    kind: 'pull_request',
    deliveryId: 'delivery-pr',
    repositoryId,
    number: 7,
    title: 'Черновик',
    state: 'open',
    merged: false,
    authorLogin: 'ada',
    updatedAt,
    mergedAt: null,
    mergedByLogin: null,
    senderLogin: 'meg',
    ...patch,
  };
}

function workflowPayload(input: {
  action?: string;
  branch?: string;
  conclusion?: string | null;
  defaultBranch?: string;
  numbers?: number[];
  repository?: number;
} = {}): Record<string, unknown> {
  return {
    action: input.action ?? 'completed',
    workflow_run: {
      head_branch: input.branch ?? 'main',
      conclusion: input.conclusion === undefined ? 'failure' : input.conclusion,
      pull_requests: (input.numbers ?? [7]).map((number) => ({ number })),
    },
    repository: {
      id: input.repository ?? 42,
      default_branch: input.defaultBranch ?? 'main',
    },
    sender: { login: 'ci' },
  };
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openMirror(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  await sql`
    INSERT INTO repositories (id, owner, name)
    VALUES (${repositoryId}, 'acme', 'bot')
  `.execute(db);
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function deliver(db: Kysely<Database>, delivery: GithubDelivery): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const result = await recordGithubDelivery(createEventJournal(trx), clock, delivery);
    if (result.status !== 'applied') return;
    if (result.eventType === EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED) {
      await mirrorGithubPullRequest(trx, result.payload, randomUUID());
    }
    if (result.eventType === EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED) {
      await mirrorGithubWorkflow(trx, result.payload);
    }
  });
}

async function accept(
  db: Kysely<Database>,
  eventName: string,
  deliveryId: string,
  body: Buffer,
): Promise<number> {
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return db.transaction().execute((trx) =>
    acceptGithubWebhook({
      secret,
      eventName,
      deliveryId,
      signature,
      body,
      journal: createEventJournal(trx),
      clock,
      applyPullRequest: async (payload) => {
        await mirrorGithubPullRequest(trx, payload, randomUUID());
      },
      applyWorkflow: async (payload) => {
        await mirrorGithubWorkflow(trx, payload);
      },
    }),
  );
}

describe('CI зеркала — поля и webhook workflow_run', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('поля CI, даты PR и логин слившего живут в зеркале репозитория', async () => {
    expect(workflowConclusion('failure')).toBe('failure');
    expect(workflowConclusion(' TIMED_OUT ')).toBe('other');
    expect(workflowConclusion(null)).toBeNull();
    expect(workflowConclusion('  ')).toBeNull();
    expect(ciBranch(' main ')).toBe('main');
    expect(() => ciStatus('red')).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CI_STATUS }));
    expect(() => ciBranch('  ')).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.CI_BRANCH }));
    const open = definePullRequest({
      id: '00000000-0000-4000-8000-0000000000d1',
      repositoryId: ' 42 ',
      pullRequestNumber: 7,
      title: ' Черновик ',
      authorLogin: ' ada ',
      state: 'open',
      ciStatus: ' failure ',
      updatedAt: ` ${updatedAt} `,
      mergedAt: mergedAt,
      mergedByLogin: 'meg',
    });
    expect(open).toMatchObject({
      repositoryId,
      title: 'Черновик',
      authorLogin: 'ada',
      state: PULL_REQUEST_STATE_OPEN,
      ciStatus: 'failure',
      updatedAt,
      mergedAt: null,
      mergedByLogin: null,
    });
    expect(definePullRequest({
      id: '00000000-0000-4000-8000-0000000000d2',
      repositoryId,
      pullRequestNumber: 3,
      title: 'Слито',
      authorLogin: 'ada',
      state: 'merged',
      ciStatus: null,
      updatedAt,
      mergedAt: ` ${mergedAt} `,
      mergedByLogin: ' meg ',
    })).toMatchObject({
      state: PULL_REQUEST_STATE_MERGED,
      ciStatus: null,
      mergedAt,
      mergedByLogin: 'meg',
    });
    expect(() => definePullRequest({
      id: '00000000-0000-4000-8000-0000000000d3',
      repositoryId,
      pullRequestNumber: 4,
      title: 'Дата',
      authorLogin: 'ada',
      state: 'open',
      ciStatus: null,
      updatedAt: ' ',
      mergedAt: null,
      mergedByLogin: null,
    })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_UPDATED_AT }));

    const handle = await openMirror();
    opened.push(handle);
    const repositoryColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'repositories'
      ORDER BY column_name
    `.execute(handle.db);
    expect(repositoryColumns.rows.map((row) => row.column_name)).toContain('default_branch_ci');
    const projectColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects'
    `.execute(handle.db);
    expect(projectColumns.rows.map((row) => row.column_name)).not.toContain('default_branch_ci');
    expect(projectColumns.rows.map((row) => row.column_name)).not.toContain('ci_status');

    await expect(sql`
      UPDATE repositories SET default_branch_ci = 'red' WHERE id = ${repositoryId}
    `.execute(handle.db)).rejects.toThrow(/repositories_default_branch_ci|23514/);
    await expect(sql`
      INSERT INTO pull_requests (
        id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at
      )
      VALUES (
        '00000000-0000-4000-8000-0000000000d4'::uuid,
        ${repositoryId}, 8, 'Красный', 'ada', 'open', 'red', ${updatedAt}::timestamptz
      )
    `.execute(handle.db)).rejects.toThrow(/pull_requests_ci_status|23514/);
    await expect(sql`
      INSERT INTO pull_requests (
        id, repository_id, pull_request_number, title, author_login, state, updated_at, merged_at
      )
      VALUES (
        '00000000-0000-4000-8000-0000000000d5'::uuid,
        ${repositoryId}, 9, 'Открыт', 'ada', 'open', ${updatedAt}::timestamptz, ${mergedAt}::timestamptz
      )
    `.execute(handle.db)).rejects.toThrow(/pull_requests_merged_fields|23514/);
    await expect(sql`
      INSERT INTO pull_requests (
        id, repository_id, pull_request_number, title, author_login, state, updated_at, merged_by_login
      )
      VALUES (
        '00000000-0000-4000-8000-0000000000d6'::uuid,
        ${repositoryId}, 10, 'Логин', 'ada', 'merged', ${updatedAt}::timestamptz, '   '
      )
    `.execute(handle.db)).rejects.toThrow(/pull_requests_merged_by_login|23514/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state)
      VALUES ('00000000-0000-4000-8000-0000000000d7'::uuid, ${repositoryId}, 11, 'Без даты', 'ada', 'open')
    `.execute(handle.db)).rejects.toThrow(/null value|23502/);
  });

  it('INV-12 красный CI не переводит задачи и не пишет блокер', async () => {
    expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    const source = mirrorSource();
    expect(source).not.toContain('domain/tasks');
    expect(source).not.toContain('transitionTask');
    expect(source).not.toContain('TASK_STATUS_BLOCKED');
    const handle = await openMirror();
    opened.push(handle);
    await sql`
      INSERT INTO projects (id, name, description, timezone, repository_id, created_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000a1'::uuid, 'Альфа', '', 'Europe/Moscow', ${repositoryId}, now()),
        ('00000000-0000-4000-8000-0000000000a2'::uuid, 'Бета', '', 'Europe/Moscow', ${repositoryId}, now())
    `.execute(handle.db);
    await deliver(handle.db, pullRequestDelivery());
    const body = Buffer.from(JSON.stringify(workflowPayload()));
    expect(await accept(handle.db, 'workflow_run', 'delivery-ci', body)).toBe(200);
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events ORDER BY created_at`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
      EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED,
    ]);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.REPO_PR_STALLED);
    const repository = await sql<{ default_branch_ci: string | null }>`
      SELECT default_branch_ci FROM repositories WHERE id = ${repositoryId}
    `.execute(handle.db);
    expect(repository.rows).toEqual([{ default_branch_ci: 'failure' }]);
    const pull = await sql<{ ci_status: string | null }>`SELECT ci_status FROM pull_requests`.execute(handle.db);
    expect(pull.rows).toEqual([{ ci_status: 'failure' }]);
    const repos = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM repositories`.execute(handle.db);
    expect(Number(repos.rows[0]?.n)).toBe(1);
  });

  it('INV-21 запись CI не пишет в GitHub и не заводит задачу', async () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = mirrorSource();
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
    expect(source).not.toContain('domain/tasks');
    const handle = await openMirror();
    opened.push(handle);
    expect(await accept(handle.db, 'workflow_run', 'delivery-ci', Buffer.from(JSON.stringify(workflowPayload())))).toBe(200);
    const events = await sql<{ event_type: string; subject_entity: string }>`
      SELECT event_type, subject_entity FROM events
    `.execute(handle.db);
    expect(events.rows).toEqual([{ event_type: EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED, subject_entity: 'Repository' }]);
    const pulls = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM pull_requests`.execute(handle.db);
    expect(Number(pulls.rows[0]?.n)).toBe(0);
    const tasks = await sql<{ present: string | null }>`
      SELECT to_regclass('public.tasks')::text AS present
    `.execute(handle.db);
    expect(tasks.rows[0]?.present).toBeNull();
  });

  it('INV-22 повтор workflow не пишет второе событие и не меняет CI', async () => {
    const handle = await openMirror();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    const first = Buffer.from(JSON.stringify(workflowPayload({ conclusion: 'failure', numbers: [7, 7] })));
    const second = Buffer.from(JSON.stringify(workflowPayload({ conclusion: 'success', numbers: [7] })));
    expect(await accept(handle.db, 'workflow_run', 'delivery-same', first)).toBe(200);
    expect(await accept(handle.db, 'workflow_run', 'delivery-same', second)).toBe(200);
    const events = await sql<{ idempotency_key: string; conclusion: string }>`
      SELECT idempotency_key, payload->>'conclusion' AS conclusion
      FROM events
      WHERE event_type = ${EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED}
    `.execute(handle.db);
    expect(events.rows).toEqual([{ idempotency_key: 'delivery-same', conclusion: 'failure' }]);
    const pull = await sql<{ ci_status: string | null }>`SELECT ci_status FROM pull_requests`.execute(handle.db);
    expect(pull.rows).toEqual([{ ci_status: 'failure' }]);
    const repository = await sql<{ default_branch_ci: string | null }>`
      SELECT default_branch_ci FROM repositories
    `.execute(handle.db);
    expect(repository.rows).toEqual([{ default_branch_ci: 'failure' }]);
  });

  it('workflow основной ветки и PR пишет CI, чужая ветка основную не затирает, неизвестный PR строку не создаёт', async () => {
    const handle = await openMirror();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    await deliver(handle.db, pullRequestDelivery({ deliveryId: 'delivery-other', number: 8, title: 'Второй' }));
    expect(await accept(
      handle.db,
      'workflow_run',
      'delivery-feature',
      Buffer.from(JSON.stringify(workflowPayload({
        branch: 'feature',
        defaultBranch: 'main',
        conclusion: 'success',
        numbers: [7, 99],
      }))),
    )).toBe(200);
    const afterFeature = await sql<{ default_branch_ci: string | null; n: number }>`
      SELECT default_branch_ci, (SELECT CAST(count(*) AS int) FROM pull_requests) AS n
      FROM repositories
    `.execute(handle.db);
    expect(afterFeature.rows).toEqual([{ default_branch_ci: null, n: 2 }]);
    const featureCi = await sql<{ pull_request_number: number; ci_status: string | null }>`
      SELECT pull_request_number, ci_status FROM pull_requests ORDER BY pull_request_number
    `.execute(handle.db);
    expect(featureCi.rows).toEqual([
      { pull_request_number: 7, ci_status: 'success' },
      { pull_request_number: 8, ci_status: null },
    ]);

    expect(await accept(
      handle.db,
      'workflow_run',
      'delivery-main',
      Buffer.from(JSON.stringify(workflowPayload({ conclusion: 'cancelled', numbers: [7, 8] }))),
    )).toBe(200);
    const afterMain = await sql<{ default_branch_ci: string | null }>`
      SELECT default_branch_ci FROM repositories
    `.execute(handle.db);
    expect(afterMain.rows).toEqual([{ default_branch_ci: 'cancelled' }]);
    const mainCi = await sql<{ ci_status: string | null }>`
      SELECT ci_status FROM pull_requests ORDER BY pull_request_number
    `.execute(handle.db);
    expect(mainCi.rows).toEqual([{ ci_status: 'cancelled' }, { ci_status: 'cancelled' }]);

    expect(await accept(
      handle.db,
      'workflow_run',
      'delivery-progress',
      Buffer.from(JSON.stringify(workflowPayload({ action: 'in_progress', conclusion: null }))),
    )).toBe(200);
    expect(await accept(
      handle.db,
      'workflow_run',
      'delivery-skipped',
      Buffer.from(JSON.stringify(workflowPayload({ conclusion: 'timed_out', branch: 'main' }))),
    )).toBe(200);
    const skipped = await sql<{ default_branch_ci: string | null }>`
      SELECT default_branch_ci FROM repositories
    `.execute(handle.db);
    expect(skipped.rows).toEqual([{ default_branch_ci: 'other' }]);

    const absent = Buffer.from(JSON.stringify(workflowPayload({ repository: 99, numbers: [] })));
    expect(await accept(handle.db, 'workflow_run', 'delivery-absent', absent)).toBe(200);
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM repositories`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);

    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES (${rootId}::uuid, 1001, 'Корень', true)
    `.execute(handle.db);
    const listed = createInstallationRepositories(handle.db, {
      async list() {
        return [{ id: repositoryId, owner: 'acme', name: 'renamed' }];
      },
    });
    await listed.show({ telegramUserId: '1001', chat: 'private', idempotencyKey: 'list-ci' });
    const kept = await sql<{ name: string; default_branch_ci: string | null }>`
      SELECT name, default_branch_ci FROM repositories
    `.execute(handle.db);
    expect(kept.rows).toEqual([{ name: 'renamed', default_branch_ci: 'other' }]);
  });

  it('pull request хранит updated_at, merged_at и merged_by_login, а CI при правке названия не сбрасывает', async () => {
    const handle = await openMirror();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    expect(await accept(
      handle.db,
      'workflow_run',
      'delivery-ci',
      Buffer.from(JSON.stringify(workflowPayload({ conclusion: 'failure' }))),
    )).toBe(200);
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-title',
      title: 'Новое',
      updatedAt: mergedAt,
    }));
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-merged',
      state: 'closed',
      merged: true,
      title: 'Слито',
      updatedAt: mergedAt,
      mergedAt,
      mergedByLogin: 'meg',
    }));
    const merged = await sql<{
      title: string;
      state: string;
      ci_status: string | null;
      updated_at: Date;
      merged_at: Date | null;
      merged_by_login: string | null;
    }>`
      SELECT title, state, ci_status, updated_at, merged_at, merged_by_login FROM pull_requests
    `.execute(handle.db);
    expect(merged.rows).toEqual([{
      title: 'Слито',
      state: PULL_REQUEST_STATE_MERGED,
      ci_status: 'failure',
      updated_at: new Date(mergedAt),
      merged_at: new Date(mergedAt),
      merged_by_login: 'meg',
    }]);
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-reopened',
      state: 'open',
      merged: false,
      title: 'Снова',
      updatedAt,
      mergedAt,
      mergedByLogin: 'meg',
    }));
    const reopened = await sql<{ state: string; merged_at: Date | null; merged_by_login: string | null; ci_status: string | null }>`
      SELECT state, merged_at, merged_by_login, ci_status FROM pull_requests
    `.execute(handle.db);
    expect(reopened.rows).toEqual([{
      state: PULL_REQUEST_STATE_OPEN,
      merged_at: null,
      merged_by_login: null,
      ci_status: 'failure',
    }]);
    const blank = Buffer.from(JSON.stringify(workflowPayload({ branch: '  ' })));
    expect(await accept(handle.db, 'workflow_run', 'delivery-blank-branch', blank)).toBe(400);
  });
});
