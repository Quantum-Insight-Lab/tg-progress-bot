import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  githubWriteCommands,
  recordGithubDelivery,
  type GithubDelivery,
  type PullRequestDelivery,
} from '../src/domain/github/delivery.ts';
import {
  definePullRequest,
  PULL_REQUEST_STATE_CLOSED,
  PULL_REQUEST_STATE_MERGED,
  PULL_REQUEST_STATE_OPEN,
  pullRequestNaturalKey,
  type PullRequest,
} from '../src/domain/github/pull-request.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readCiMirrorMigration, readEventsMigration, readProjectsMigration, readPullRequestsMigration, readRepositoriesMigration } from '../src/infrastructure/migrate.ts';
import { mirrorGithubPullRequest } from '../src/infrastructure/pull-request-mirror.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const repositoryId = '42';
const otherRepositoryId = '7';
const updatedAt = '2026-09-28T07:33:00Z';
const secret = 'hook-secret';
const projectA = '00000000-0000-4000-8000-0000000000a1';
const projectB = '00000000-0000-4000-8000-0000000000a2';

const openPullRequest: PullRequest = {
  id: '00000000-0000-4000-8000-0000000000d1',
  repositoryId,
  pullRequestNumber: 7,
  title: 'Черновик',
  authorLogin: 'ada',
  state: PULL_REQUEST_STATE_OPEN,
  ciStatus: null,
  updatedAt,
  mergedAt: null,
  mergedByLogin: null,
};

const mergedPullRequest: PullRequest = {
  id: '00000000-0000-4000-8000-0000000000d2',
  repositoryId: otherRepositoryId,
  pullRequestNumber: 3,
  title: 'Сдано',
  authorLogin: 'meg',
  state: PULL_REQUEST_STATE_MERGED,
  ciStatus: null,
  updatedAt,
  mergedAt: updatedAt,
  mergedByLogin: 'meg',
};

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

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openPullRequests(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  await sql`
    INSERT INTO repositories (id, owner, name)
    VALUES (${repositoryId}, 'acme', 'bot'), (${otherRepositoryId}, 'acme', 'api')
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
    const result = await recordGithubDelivery(createEventJournal(trx, silentLogger), clock, delivery);
    if (result.status === 'applied' && result.eventType === EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED) {
      await mirrorGithubPullRequest(trx, result.payload, randomUUID());
    }
  });
}

async function pullRequestCount(db: Kysely<Database>): Promise<number> {
  const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM pull_requests`.execute(db);
  return Number(count.rows[0]?.n);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pull_requests'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

async function insertPullRequest(db: Kysely<Database>, pullRequest: PullRequest): Promise<void> {
  const row = definePullRequest(pullRequest);
  await sql`
    INSERT INTO pull_requests (
      id, repository_id, pull_request_number, title, author_login, state,
      ci_status, updated_at, merged_at, merged_by_login
    )
    VALUES (
      ${row.id}::uuid,
      ${row.repositoryId},
      ${row.pullRequestNumber},
      ${row.title},
      ${row.authorLogin},
      ${row.state},
      ${row.ciStatus},
      ${row.updatedAt}::timestamptz,
      ${row.mergedAt}::timestamptz,
      ${row.mergedByLogin}
    )
  `.execute(db);
}

describe('E-14 pull request — таблица pull_requests', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('поля pull request: id, репозиторий, номер, название, автор и состояние', async () => {
    expect(definePullRequest(openPullRequest)).toEqual(openPullRequest);
    expect(definePullRequest({ ...openPullRequest, title: '  Черновик  ', authorLogin: ' ada ' }).authorLogin).toBe('ada');
    expect(definePullRequest(mergedPullRequest).state).toBe(PULL_REQUEST_STATE_MERGED);
    expect(() => definePullRequest({ ...openPullRequest, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_ID_BLANK }),
    );
    expect(() => definePullRequest({ ...openPullRequest, title: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_TITLE_BLANK }),
    );
    expect(() => definePullRequest({ ...openPullRequest, authorLogin: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_AUTHOR_LOGIN }),
    );
    expect(() => definePullRequest({ ...openPullRequest, state: 'draft' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_STATE }),
    );
    expect(() => definePullRequest({ ...openPullRequest, pullRequestNumber: 0 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PULL_REQUEST_NUMBER }),
    );
    expect(pullRequestNaturalKey(' 42 ', 7)).toEqual({ repositoryId, pullRequestNumber: 7 });

    const handle = await openPullRequests();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'author_login',
      'ci_status',
      'id',
      'merged_at',
      'merged_by_login',
      'pull_request_number',
      'repository_id',
      'state',
      'title',
      'updated_at',
    ]);
    expect(await columnNames(handle.db)).not.toContain('project_id');
    expect(await columnNames(handle.db)).not.toContain('task_id');
    await insertPullRequest(handle.db, openPullRequest);
    await insertPullRequest(handle.db, mergedPullRequest);
    const rows = await sql<{
      id: string;
      repository_id: string;
      pull_request_number: number;
      title: string;
      author_login: string;
      state: string;
    }>`
      SELECT
        id::text AS id,
        repository_id,
        pull_request_number,
        title,
        author_login,
        state
      FROM pull_requests
      ORDER BY pull_request_number
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        id: mergedPullRequest.id,
        repository_id: otherRepositoryId,
        pull_request_number: 3,
        title: 'Сдано',
        author_login: 'meg',
        state: PULL_REQUEST_STATE_MERGED,
      },
      {
        id: openPullRequest.id,
        repository_id: repositoryId,
        pull_request_number: 7,
        title: 'Черновик',
        author_login: 'ada',
        state: PULL_REQUEST_STATE_OPEN,
      },
    ]);
  });

  it('ключ — id; природный ключ — репозиторий и номер; название, автор и состояние держат constraint', async () => {
    const handle = await openPullRequests();
    opened.push(handle);
    await insertPullRequest(handle.db, openPullRequest);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES (${openPullRequest.id}::uuid, ${otherRepositoryId}, 9, 'Другой', 'ada', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_pkey|23505/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d3'::uuid, ${repositoryId}, 7, 'Дубль', 'ada', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_repository_number_unique|23505/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d4'::uuid, '99', 1, 'Нет репозитория', 'ada', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_repository_id_fkey|23503/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d5'::uuid, ${repositoryId}, 0, 'Ноль', 'ada', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_number_positive|23514/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d6'::uuid, ${repositoryId}, 2, '   ', 'ada', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_title_not_blank|23514/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d7'::uuid, ${repositoryId}, 2, 'Автор', '   ', 'open', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_author_login_not_blank|23514/);
    await expect(sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, updated_at)
      VALUES ('00000000-0000-4000-8000-0000000000d8'::uuid, ${repositoryId}, 2, 'Состояние', 'ada', 'draft', ${updatedAt}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/pull_requests_state|23514/);
    expect(await pullRequestCount(handle.db)).toBe(1);
  });
});

describe('зеркало pull request по webhook', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-12 зеркало pull request не переводит задачи и не пишет блокер', async () => {
    expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/pull-request.ts',
      'src/domain/github/pull-request-mirror.ts',
      'src/infrastructure/pull-request-mirror.ts',
    ]);
    expect(source).not.toContain('domain/tasks');
    expect(source).not.toContain('transitionTask');
    expect(source).not.toContain('TASK_STATUS_BLOCKED');
    const handle = await openPullRequests();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-merged',
      repositoryId: otherRepositoryId,
      number: 3,
      title: 'Сдано',
      state: 'closed',
      merged: true,
      authorLogin: 'meg',
    }));
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events ORDER BY created_at`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
      EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
    ]);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.REPO_PR_STALLED);
    const states = await sql<{ state: string }>`SELECT state FROM pull_requests ORDER BY pull_request_number`.execute(handle.db);
    expect(states.rows.map((row) => row.state)).toEqual([PULL_REQUEST_STATE_MERGED, PULL_REQUEST_STATE_OPEN]);
    expect(await columnNames(handle.db)).not.toContain('task_id');
  });

  it('INV-13 автор PR хранится как логин действующего лица, чужой логин не копируется на проект', async () => {
    const handle = await openPullRequests();
    opened.push(handle);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', now())
    `.execute(handle.db);
    await deliver(handle.db, pullRequestDelivery({ authorLogin: 'outsider', senderLogin: 'meg' }));
    const rows = await sql<{ author_login: string }>`SELECT author_login FROM pull_requests`.execute(handle.db);
    expect(rows.rows).toEqual([{ author_login: 'outsider' }]);
    expect(await pullRequestCount(handle.db)).toBe(1);
    expect(await columnNames(handle.db)).not.toContain('project_id');
    const events = await sql<{ event_type: string; actor_id: string }>`
      SELECT event_type, actor_id FROM events
    `.execute(handle.db);
    expect(events.rows).toEqual([{ event_type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED, actor_id: 'outsider' }]);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.REPO_PR_STALLED);
  });

  it('INV-21 запись зеркала pull request не пишет в GitHub и не заводит задачу', async () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/pull-request.ts',
      'src/domain/github/pull-request-mirror.ts',
      'src/infrastructure/pull-request-mirror.ts',
    ]);
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
    expect(source).not.toContain('domain/tasks');
    const handle = await openPullRequests();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED]);
    expect(await columnNames(handle.db)).not.toContain('task_id');
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', now())
    `.execute(handle.db);
    expect(await pullRequestCount(handle.db)).toBe(1);
  });

  it('INV-22 повтор доставки pull request не пишет второе событие и не меняет строку', async () => {
    const handle = await openPullRequests();
    opened.push(handle);
    const first = Buffer.from(
      JSON.stringify({
        action: 'opened',
        pull_request: {
          number: 7,
          title: 'Черновик',
          state: 'open',
          merged: false,
          updated_at: updatedAt,
          merged_at: null,
          user: { login: 'ada' },
        },
        repository: { id: 42 },
        sender: { login: 'meg' },
      }),
    );
    const signed = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const once = async (body: Buffer, deliveryId: string) =>
      handle.db.transaction().execute((trx) =>
        acceptGithubWebhook({
          secret,
          eventName: 'pull_request',
          deliveryId,
          signature: signed(body),
          body,
          journal: createEventJournal(trx, silentLogger),
          clock,
          logger: silentLogger,
          applyPullRequest: async (payload) => {
            await mirrorGithubPullRequest(trx, payload, randomUUID());
          },
        }),
      );
    expect(await once(first, 'delivery-same')).toBe(200);
    const second = Buffer.from(
      JSON.stringify({
        action: 'closed',
        pull_request: {
          number: 7,
          title: 'Другое',
          state: 'closed',
          merged: true,
          updated_at: updatedAt,
          merged_at: updatedAt,
          user: { login: 'ada' },
          merged_by: { login: 'meg' },
        },
        repository: { id: 42 },
        sender: { login: 'meg' },
      }),
    );
    expect(await once(second, 'delivery-same')).toBe(200);
    expect(await pullRequestCount(handle.db)).toBe(1);
    const rows = await sql<{ title: string; state: string; author_login: string; idempotency_key: string }>`
      SELECT p.title, p.state, p.author_login, e.idempotency_key
      FROM pull_requests AS p
      JOIN events AS e ON e.event_type = ${EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED}
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { title: 'Черновик', state: PULL_REQUEST_STATE_OPEN, author_login: 'ada', idempotency_key: 'delivery-same' },
    ]);
    const forged = await acceptGithubWebhook({
      secret,
      eventName: 'pull_request',
      deliveryId: 'delivery-forged',
      signature: signed(Buffer.from('{}')),
      body: first,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: silentLogger,
    });
    expect(forged).toBe(401);
    expect(await pullRequestCount(handle.db)).toBe(1);
  });

  it('открытый и смерженный PR лежат в зеркале репозитория, закрытый без слияния ту же строку обновляет', async () => {
    const handle = await openPullRequests();
    opened.push(handle);
    await deliver(handle.db, pullRequestDelivery());
    const first = await sql<{ id: string }>`SELECT id::text AS id FROM pull_requests`.execute(handle.db);
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-closed',
      state: 'closed',
      merged: false,
      title: 'Закрыт',
    }));
    expect(await pullRequestCount(handle.db)).toBe(1);
    const closed = await sql<{ id: string; title: string; state: string }>`
      SELECT id::text AS id, title, state FROM pull_requests
    `.execute(handle.db);
    expect(closed.rows[0]).toEqual({
      id: first.rows[0]?.id,
      title: 'Закрыт',
      state: PULL_REQUEST_STATE_CLOSED,
    });
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-merged',
      state: 'closed',
      merged: true,
      title: 'Слито',
    }));
    const merged = await sql<{ id: string; state: string }>`
      SELECT id::text AS id, state FROM pull_requests
    `.execute(handle.db);
    expect(merged.rows[0]).toEqual({ id: first.rows[0]?.id, state: PULL_REQUEST_STATE_MERGED });
    await deliver(handle.db, pullRequestDelivery({
      deliveryId: 'delivery-other-repo',
      repositoryId: otherRepositoryId,
      title: 'Тот же номер',
    }));
    expect(await pullRequestCount(handle.db)).toBe(2);
    const events = await sql<{ event_type: string; subject_entity: string }>`
      SELECT event_type, subject_entity FROM events ORDER BY created_at
    `.execute(handle.db);
    expect(events.rows.every((row) => row.event_type === EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED)).toBe(true);
    expect(events.rows.every((row) => row.subject_entity === 'PullRequest')).toBe(true);
  });
});
