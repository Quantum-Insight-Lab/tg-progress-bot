import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMITS_TAIL_DAYS } from '../src/config/constants.ts';
import { commitKeptInTail, commitNaturalKey, defineCommit, type Commit } from '../src/domain/github/commit.ts';
import { githubWriteCommands, recordGithubDelivery, type GithubDelivery, type PushDelivery } from '../src/domain/github/delivery.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { transitionTask } from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import { mirrorGithubCommits } from '../src/infrastructure/commit-mirror.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readCommitsMigration, readEventsMigration, readProjectsMigration, readRepositoriesMigration } from '../src/infrastructure/migrate.ts';
import { silentLogger } from './log-lines.ts';

const now = new Date('2026-09-28T07:33:00.000Z');
const clock: Clock = { now: () => now };
const repositoryId = '42';
const otherRepositoryId = '7';
const secret = 'hook-secret';
const projectA = '00000000-0000-4000-8000-0000000000a1';
const projectB = '00000000-0000-4000-8000-0000000000a2';
const DAY_MS = 24 * 60 * 60 * 1000;

function atDaysBefore(days: number, extraMs = 0): string {
  return new Date(now.getTime() - days * DAY_MS - extraMs).toISOString();
}

const insideTail = atDaysBefore(COMMITS_TAIL_DAYS - 1);
const onTailEdge = atDaysBefore(COMMITS_TAIL_DAYS);
const outsideTail = atDaysBefore(COMMITS_TAIL_DAYS, 1);

const freshCommit: Commit = {
  id: '00000000-0000-4000-8000-0000000000c1',
  repositoryId,
  sha: 'abc123',
  message: 'Сделано',
  authorLogin: 'ada',
  createdAt: insideTail,
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

function pushDelivery(patch: Partial<PushDelivery> = {}): PushDelivery {
  return {
    kind: 'push',
    deliveryId: 'delivery-push',
    repositoryId,
    commits: [
      { sha: 'abc123', message: 'Сделано', authorLogin: 'ada', createdAt: insideTail },
    ],
    senderLogin: 'meg',
    ...patch,
  };
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openCommits(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readCommitsMigration());
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

async function deliver(db: Kysely<Database>, delivery: GithubDelivery, at: Date = now): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const result = await recordGithubDelivery(createEventJournal(trx, silentLogger), { now: () => at }, delivery);
    if (result.status === 'applied' && result.eventType === EVENT_TYPES.GITHUB_COMMITS_PUSHED) {
      await mirrorGithubCommits(trx, result.payload, at, randomUUID);
    }
  });
}

async function commitCount(db: Kysely<Database>): Promise<number> {
  const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM commits`.execute(db);
  return Number(count.rows[0]?.n);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commits'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

async function shas(db: Kysely<Database>, repo = repositoryId): Promise<string[]> {
  const rows = await sql<{ sha: string }>`
    SELECT sha FROM commits WHERE repository_id = ${repo} ORDER BY sha
  `.execute(db);
  return rows.rows.map((row) => row.sha);
}

describe('E-15 коммит — таблица commits', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('поля коммита: id, репозиторий, sha, сообщение, автор и дата', () => {
    expect(defineCommit(freshCommit)).toEqual(freshCommit);
    expect(defineCommit({ ...freshCommit, sha: ' ABC123 ', authorLogin: ' ada ', message: '  Сделано  ' })).toMatchObject({
      sha: 'abc123',
      authorLogin: 'ada',
      message: 'Сделано',
    });
    expect(commitNaturalKey(repositoryId, 'ABC123')).toEqual({ repositoryId, sha: 'abc123' });
    expect(commitKeptInTail(onTailEdge, now)).toBe(true);
    expect(commitKeptInTail(outsideTail, now)).toBe(false);
    expect(() => defineCommit({ ...freshCommit, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.COMMIT_ID_BLANK }),
    );
    expect(() => defineCommit({ ...freshCommit, sha: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.COMMIT_SHA_BLANK }),
    );
    expect(() => defineCommit({ ...freshCommit, message: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.COMMIT_MESSAGE_BLANK }),
    );
    expect(() => defineCommit({ ...freshCommit, authorLogin: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.COMMIT_AUTHOR_LOGIN }),
    );
    expect(() => defineCommit({ ...freshCommit, createdAt: 'вчера' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.COMMIT_CREATED_AT }),
    );
  });

  it('ключ — id; природный ключ — репозиторий и sha; сообщение и автор держат constraint', async () => {
    const handle = await openCommits();
    opened.push(handle);
    const row = defineCommit(freshCommit);
    await sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES (
        ${row.id}::uuid, ${row.repositoryId}, ${row.sha}, ${row.message}, ${row.authorLogin}, ${row.createdAt}::timestamptz
      )
    `.execute(handle.db);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES (${row.id}::uuid, ${otherRepositoryId}, 'def456', 'Другой', 'ada', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_pkey|23505/);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c2'::uuid, ${repositoryId}, ${row.sha}, 'Дубль', 'ada', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_repository_sha_unique|23505/);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c3'::uuid, '99', 'fff', 'Нет репозитория', 'ada', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_repository_id_fkey|23503/);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c4'::uuid, ${repositoryId}, '   ', 'Пустой sha', 'ada', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_sha_not_blank|23514/);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c5'::uuid, ${repositoryId}, 'eee', '   ', 'ada', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_message_not_blank|23514/);
    await expect(sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c6'::uuid, ${repositoryId}, 'ddd', 'Автор', '   ', ${insideTail}::timestamptz)
    `.execute(handle.db)).rejects.toThrow(/commits_author_login_not_blank|23514/);
    expect(await commitCount(handle.db)).toBe(1);
    expect(await columnNames(handle.db)).toEqual([
      'author_login',
      'created_at',
      'id',
      'message',
      'repository_id',
      'sha',
    ]);
  });
});

describe('зеркало коммитов по webhook push', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-13 автор коммита хранится как логин, чужой логин не копируется на проект и блокер не поднимает', async () => {
    const handle = await openCommits();
    opened.push(handle);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', now())
    `.execute(handle.db);
    await deliver(handle.db, pushDelivery({
      commits: [{ sha: 'abc123', message: 'Сделано', authorLogin: 'outsider', createdAt: insideTail }],
      senderLogin: 'meg',
    }));
    const rows = await sql<{ author_login: string; sha: string }>`
      SELECT author_login, sha FROM commits
    `.execute(handle.db);
    expect(rows.rows).toEqual([{ author_login: 'outsider', sha: 'abc123' }]);
    expect(await commitCount(handle.db)).toBe(1);
    expect(await columnNames(handle.db)).not.toContain('project_id');
    const events = await sql<{ event_type: string; actor_id: string }>`
      SELECT event_type, actor_id FROM events
    `.execute(handle.db);
    expect(events.rows).toEqual([{ event_type: EVENT_TYPES.GITHUB_COMMITS_PUSHED, actor_id: 'meg' }]);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.DIVERGENCE_DETECTED);
  });

  it('INV-15 хвост хранит движение внутри окна и не трогает статусы, блокеры и CI', async () => {
    expect(() => transitionTask(TASK_STATUS_IN_PROGRESS, EVENT_TYPES.GITHUB_COMMITS_PUSHED)).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/commit.ts',
      'src/domain/github/commit-mirror.ts',
      'src/infrastructure/commit-mirror.ts',
    ]);
    expect(source).not.toContain('domain/tasks');
    expect(source).not.toContain('transitionTask');
    expect(source).not.toContain('TASK_STATUS_BLOCKED');
    expect(source).not.toContain('default_branch_ci');
    const handle = await openCommits();
    opened.push(handle);
    await sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000c7'::uuid, ${repositoryId}, 'oldsha', 'Давно', 'ada', ${outsideTail}::timestamptz),
        ('00000000-0000-4000-8000-0000000000c8'::uuid, ${otherRepositoryId}, 'oldother', 'Чужой репозиторий', 'ada', ${outsideTail}::timestamptz)
    `.execute(handle.db);
    await deliver(handle.db, pushDelivery({
      commits: [
        { sha: 'abc123', message: 'Сделано', authorLogin: 'ada', createdAt: insideTail },
        { sha: 'edge', message: 'На границе', authorLogin: 'ada', createdAt: onTailEdge },
        { sha: 'ancient', message: 'История', authorLogin: 'ada', createdAt: outsideTail },
      ],
    }));
    expect(await shas(handle.db)).toEqual(['abc123', 'edge']);
    expect(await shas(handle.db, otherRepositoryId)).toEqual(['oldother']);
    const later = new Date(now.getTime() + DAY_MS);
    await deliver(handle.db, pushDelivery({ deliveryId: 'delivery-later', commits: [] }), later);
    expect(await shas(handle.db)).toEqual(['abc123']);
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events ORDER BY created_at`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      EVENT_TYPES.GITHUB_COMMITS_PUSHED,
      EVENT_TYPES.GITHUB_COMMITS_PUSHED,
    ]);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.DIVERGENCE_DETECTED);
    expect(events.rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED);
    expect(await columnNames(handle.db)).not.toContain('task_id');
    expect(await columnNames(handle.db)).not.toContain('project_id');
  });

  it('INV-21 запись зеркала коммитов не пишет в GitHub и не заводит задачу', async () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/commit.ts',
      'src/domain/github/commit-mirror.ts',
      'src/infrastructure/commit-mirror.ts',
    ]);
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
    expect(source).not.toContain('domain/tasks');
    const handle = await openCommits();
    opened.push(handle);
    await deliver(handle.db, pushDelivery());
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([EVENT_TYPES.GITHUB_COMMITS_PUSHED]);
    expect(await columnNames(handle.db)).not.toContain('task_id');
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', now())
    `.execute(handle.db);
    expect(await commitCount(handle.db)).toBe(1);
  });

  it('INV-22 повтор доставки push не пишет второе событие и не меняет строку', async () => {
    const handle = await openCommits();
    opened.push(handle);
    const body = {
      ref: 'refs/heads/main',
      repository: { id: 42 },
      sender: { login: 'meg' },
      commits: [
        {
          id: 'abc123',
          message: 'Сделано',
          timestamp: insideTail,
          author: { username: 'ada' },
          distinct: true,
        },
      ],
    };
    const first = Buffer.from(JSON.stringify(body));
    const signed = (payload: Buffer) => `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const once = async (payload: Buffer, deliveryId: string) =>
      handle.db.transaction().execute((trx) =>
        acceptGithubWebhook({
          secret,
          eventName: 'push',
          deliveryId,
          signature: signed(payload),
          body: payload,
          journal: createEventJournal(trx, silentLogger),
          clock,
          applyCommits: async (eventPayload) => {
            await mirrorGithubCommits(trx, eventPayload, clock.now(), randomUUID);
          },
        }),
      );
    expect(await once(first, 'delivery-same')).toBe(200);
    const second = Buffer.from(JSON.stringify({
      ...body,
      commits: [
        {
          id: 'abc123',
          message: 'Другое',
          timestamp: insideTail,
          author: { username: 'grace' },
        },
      ],
    }));
    expect(await once(second, 'delivery-same')).toBe(200);
    expect(await commitCount(handle.db)).toBe(1);
    const rows = await sql<{ message: string; author_login: string; idempotency_key: string }>`
      SELECT c.message, c.author_login, e.idempotency_key
      FROM commits AS c
      JOIN events AS e ON e.event_type = ${EVENT_TYPES.GITHUB_COMMITS_PUSHED}
    `.execute(handle.db);
    expect(rows.rows).toEqual([{ message: 'Сделано', author_login: 'ada', idempotency_key: 'delivery-same' }]);
    const forged = await acceptGithubWebhook({
      secret,
      eventName: 'push',
      deliveryId: 'delivery-forged',
      signature: signed(Buffer.from('{}')),
      body: first,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
    });
    expect(forged).toBe(401);
    expect(await commitCount(handle.db)).toBe(1);
  });

  it('push кладёт коммиты репозитория по sha и не пишет коммит без автора', async () => {
    const handle = await openCommits();
    opened.push(handle);
    const body = Buffer.from(JSON.stringify({
      ref: 'refs/heads/main',
      repository: { id: 42 },
      sender: { login: 'meg' },
      commits: [
        { id: 'ABC123', message: '  Сделано  ', timestamp: insideTail, author: { username: ' ada ' } },
        { id: 'abc123', message: 'Повтор', timestamp: insideTail, author: { username: 'grace' } },
        { id: 'ancient', message: 'История', timestamp: outsideTail, author: { username: 'ada' } },
        { id: 'nolgin', message: 'Без логина', timestamp: insideTail, author: { name: 'Ada' } },
        { message: 'Без sha', timestamp: insideTail, author: { username: 'ada' } },
      ],
    }));
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const status = await handle.db.transaction().execute((trx) =>
      acceptGithubWebhook({
        secret,
        eventName: 'push',
        deliveryId: 'delivery-batch',
        signature,
        body,
        journal: createEventJournal(trx, silentLogger),
        clock,
        applyCommits: async (payload) => {
          await mirrorGithubCommits(trx, payload, clock.now(), randomUUID);
        },
      }),
    );
    expect(status).toBe(200);
    const rows = await sql<{ sha: string; message: string; author_login: string }>`
      SELECT sha, message, author_login FROM commits ORDER BY sha
    `.execute(handle.db);
    expect(rows.rows).toEqual([{ sha: 'abc123', message: 'Сделано', author_login: 'ada' }]);
    const payload = await sql<{ payload: { commits: { sha: string }[] } }>`
      SELECT payload FROM events
    `.execute(handle.db);
    expect(payload.rows[0]?.payload.commits.map((commit) => commit.sha).sort()).toEqual(['abc123', 'ancient']);
    const again = Buffer.from(JSON.stringify({
      repository: { id: 42 },
      sender: { login: 'meg' },
      commits: [{ id: 'abc123', message: 'Уточнение', timestamp: insideTail, author: { username: 'ada' } }],
    }));
    const firstId = await sql<{ id: string }>`SELECT id::text AS id FROM commits`.execute(handle.db);
    await handle.db.transaction().execute((trx) =>
      acceptGithubWebhook({
        secret,
        eventName: 'push',
        deliveryId: 'delivery-update',
        signature: `sha256=${createHmac('sha256', secret).update(again).digest('hex')}`,
        body: again,
        journal: createEventJournal(trx, silentLogger),
        clock,
        applyCommits: async (eventPayload) => {
          await mirrorGithubCommits(trx, eventPayload, clock.now(), randomUUID);
        },
      }),
    );
    const updated = await sql<{ id: string; message: string }>`
      SELECT id::text AS id, message FROM commits
    `.execute(handle.db);
    expect(updated.rows).toEqual([{ id: firstId.rows[0]?.id, message: 'Уточнение' }]);
    const broken = Buffer.from(JSON.stringify({
      repository: { id: 42 },
      commits: [1],
    }));
    const rejected = await acceptGithubWebhook({
      secret,
      eventName: 'push',
      deliveryId: 'delivery-broken',
      signature: `sha256=${createHmac('sha256', secret).update(broken).digest('hex')}`,
      body: broken,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
    });
    expect(rejected).toBe(400);
    expect(await commitCount(handle.db)).toBe(1);
  });
});
