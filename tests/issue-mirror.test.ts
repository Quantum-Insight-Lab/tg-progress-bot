import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { githubWriteCommands, recordGithubDelivery, type GithubDelivery, type IssueDelivery, type PullRequestDelivery } from '../src/domain/github/delivery.ts';
import { defineIssueAssignee } from '../src/domain/github/issue-assignee.ts';
import { issueNaturalKey } from '../src/domain/github/issue.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { mirrorGithubIssue } from '../src/infrastructure/issue-mirror.ts';
import {
  readEventsMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const repositoryId = '42';
const otherRepositoryId = '7';
const updatedAt = '2026-09-28T07:33:00.000Z';
const laterAt = '2026-09-28T18:00:00.000Z';
const projectA = '00000000-0000-4000-8000-0000000000a1';
const projectB = '00000000-0000-4000-8000-0000000000a2';
const issueId = '00000000-0000-4000-8000-0000000000f1';
const secret = 'hook-secret';

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

function issueDelivery(patch: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    kind: 'issues',
    deliveryId: 'delivery-issue',
    repositoryId,
    number: 12,
    title: 'Сигналы',
    state: 'closed',
    stateReason: 'completed',
    assignees: ['ada'],
    closedByLogin: 'ada',
    updatedAt,
    isPullRequest: false,
    senderLogin: 'ada',
    ...patch,
  };
}

function pullDelivery(): PullRequestDelivery {
  return {
    kind: 'pull_request',
    deliveryId: 'delivery-pr',
    repositoryId,
    number: 12,
    title: 'Черновик',
    state: 'closed',
    merged: true,
    authorLogin: 'ada',
    updatedAt,
    mergedAt: laterAt,
    mergedByLogin: 'ada',
    senderLogin: 'ada',
  };
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openMirror(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readIssueMirrorMigration());
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
    if (result.status === 'applied' && result.eventType === EVENT_TYPES.GITHUB_ISSUE_CHANGED) {
      await mirrorGithubIssue(trx, result.payload, randomUUID());
    }
  });
}

async function issueCount(db: Kysely<Database>): Promise<number> {
  const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(db);
  return Number(count.rows[0]?.n);
}

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('зеркало issue по webhook', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-01 pull request не становится issue, зеркало не копируется в проект', async () => {
    const handle = await openMirror();
    opened.push(handle);
    expect(await columnNames(handle.db, 'issues')).not.toContain('project_id');
    await deliver(handle.db, pullDelivery());
    await deliver(handle.db, issueDelivery({ isPullRequest: true, deliveryId: 'delivery-as-pr' }));
    expect(await issueCount(handle.db)).toBe(0);
    await deliver(
      handle.db,
      issueDelivery({ deliveryId: 'delivery-dropped', number: 4, state: 'closed', stateReason: 'not_planned' }),
    );
    await deliver(handle.db, issueDelivery());
    expect(await issueCount(handle.db)).toBe(2);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', ${updatedAt}::timestamptz, ${repositoryId}),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', ${updatedAt}::timestamptz, ${repositoryId})
    `.execute(handle.db);
    const seen = await sql<{ n: number }>`
      SELECT CAST(count(DISTINCT i.id) AS int) AS n
      FROM projects AS p
      JOIN issues AS i ON i.repository_id = p.repository_id
    `.execute(handle.db);
    expect(Number(seen.rows[0]?.n)).toBe(2);
    expect(await issueCount(handle.db)).toBe(2);
    const reasons = await sql<{ state_reason: string | null }>`
      SELECT state_reason FROM issues ORDER BY state_reason NULLS LAST
    `.execute(handle.db);
    expect(reasons.rows.map((row) => row.state_reason)).toEqual(['completed', 'not_planned']);
  });

  it('INV-21 запись зеркала не пишет в GitHub', () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/issue-mirror.ts',
      'src/domain/github/issue-assignee.ts',
      'src/domain/github/issue-dependency.ts',
      'src/domain/github/issue-link.ts',
      'src/infrastructure/issue-mirror.ts',
      'src/infrastructure/issue-links.ts',
    ]);
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
  });

  it('INV-22 повтор доставки не пишет вторую строку и не меняет первую', async () => {
    const handle = await openMirror();
    opened.push(handle);
    const first = Buffer.from(
      JSON.stringify({
        action: 'closed',
        issue: {
          number: 12,
          title: 'Сигналы',
          state: 'closed',
          state_reason: 'completed',
          updated_at: updatedAt,
          closed_by: { login: 'ada' },
          assignees: [{ login: 'ada' }],
        },
        repository: { id: 42 },
        sender: { login: 'ada' },
      }),
    );
    const signed = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const once = async (body: Buffer, deliveryId: string) =>
      handle.db.transaction().execute((trx) =>
        acceptGithubWebhook({
          secret,
          eventName: 'issues',
          deliveryId,
          signature: signed(body),
          body,
          journal: createEventJournal(trx, silentLogger),
          clock,
          applyIssue: async (payload) => {
            await mirrorGithubIssue(trx, payload, randomUUID());
          },
        }),
      );
    expect(await once(first, 'delivery-same')).toBe(200);
    const second = Buffer.from(JSON.stringify({
      action: 'edited',
      issue: {
        number: 12,
        title: 'Другое',
        state: 'closed',
        state_reason: 'completed',
        updated_at: laterAt,
        closed_by: { login: 'ada' },
        assignees: [],
      },
      repository: { id: 42 },
      sender: { login: 'ada' },
    }));
    expect(await once(second, 'delivery-same')).toBe(200);
    expect(await issueCount(handle.db)).toBe(1);
    const rows = await sql<{ title: string; idempotency_key: string }>`
      SELECT i.title, e.idempotency_key
      FROM issues AS i
      JOIN events AS e ON e.event_type = ${EVENT_TYPES.GITHUB_ISSUE_CHANGED}
    `.execute(handle.db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.title).toBe('Сигналы');
    expect(rows.rows[0]?.idempotency_key).toBe('delivery-same');
  });

  it('природный ключ — одна строка на репозиторий и номер, проект в неё не входит', async () => {
    expect(issueNaturalKey(' 42 ', 12)).toEqual({ repositoryId, issueNumber: 12 });
    expect(() => issueNaturalKey('42', 0)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_NUMBER }));
    const handle = await openMirror();
    opened.push(handle);
    await deliver(handle.db, issueDelivery());
    const first = await sql<{ id: string; closed_at: Date }>`
      SELECT id::text AS id, closed_at FROM issues
    `.execute(handle.db);
    await deliver(handle.db, issueDelivery({
      deliveryId: 'delivery-edit',
      title: 'Сигналы датчика',
      updatedAt: laterAt,
    }));
    expect(await issueCount(handle.db)).toBe(1);
    const edited = await sql<{ id: string; title: string; closed_at: Date; updated_at: Date }>`
      SELECT id::text AS id, title, closed_at, updated_at FROM issues
    `.execute(handle.db);
    expect(edited.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(edited.rows[0]?.title).toBe('Сигналы датчика');
    expect(new Date(edited.rows[0]?.closed_at ?? 0).toISOString()).toBe(new Date(updatedAt).toISOString());
    expect(new Date(edited.rows[0]?.updated_at ?? 0).toISOString()).toBe(new Date(laterAt).toISOString());
    await deliver(handle.db, issueDelivery({
      deliveryId: 'delivery-other-repo',
      repositoryId: otherRepositoryId,
      title: 'Тот же номер',
    }));
    expect(await issueCount(handle.db)).toBe(2);
    await deliver(handle.db, issueDelivery({
      deliveryId: 'delivery-open',
      state: 'open',
      stateReason: null,
      closedByLogin: null,
      updatedAt: laterAt,
    }));
    const reopened = await sql<{ state: string; closed_at: Date | null; closed_by_login: string | null }>`
      SELECT state, closed_at, closed_by_login FROM issues WHERE repository_id = ${repositoryId}
    `.execute(handle.db);
    expect(reopened.rows[0]?.state).toBe('open');
    expect(reopened.rows[0]?.closed_at).toBeNull();
    expect(reopened.rows[0]?.closed_by_login).toBeNull();
    await expect(sql`
      INSERT INTO issues (id, repository_id, issue_number, title, state, updated_at)
      VALUES (
        ${issueId}::uuid,
        ${repositoryId},
        12,
        'Дубль',
        'open',
        ${updatedAt}::timestamptz
      )
    `.execute(handle.db)).rejects.toThrow(/issues_repository_number_unique|23505/);
    expect(await issueCount(handle.db)).toBe(2);
  });
});

describe('E-11 issue_assignees — поля', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('issue_id и login, без проекта; один логин на issue один раз', async () => {
    expect(defineIssueAssignee({ issueId: ` ${issueId} `, login: ' ada ' })).toEqual({ issueId, login: 'ada' });
    expect(() => defineIssueAssignee({ issueId: ' ', login: 'ada' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ID_BLANK }),
    );
    expect(() => defineIssueAssignee({ issueId, login: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ASSIGNEE_LOGIN }),
    );
    const handle = await openMirror();
    opened.push(handle);
    expect(await columnNames(handle.db, 'issue_assignees')).toEqual(['issue_id', 'login']);
    await deliver(handle.db, issueDelivery({ state: 'open', stateReason: null, closedByLogin: null, assignees: [] }));
    const stored = await sql<{ id: string }>`SELECT id::text AS id FROM issues`.execute(handle.db);
    const id = stored.rows[0]?.id ?? issueId;
    const assignee = defineIssueAssignee({ issueId: id, login: 'ada' });
    await sql`
      INSERT INTO issue_assignees (issue_id, login) VALUES (${assignee.issueId}::uuid, ${assignee.login})
    `.execute(handle.db);
    await sql`
      INSERT INTO issue_assignees (issue_id, login) VALUES (${id}::uuid, 'bob')
    `.execute(handle.db);
    await expect(sql`
      INSERT INTO issue_assignees (issue_id, login) VALUES (${id}::uuid, 'ada')
    `.execute(handle.db)).rejects.toThrow(/issue_assignees_pkey|23505/);
    await expect(sql`
      INSERT INTO issue_assignees (issue_id, login) VALUES (${id}::uuid, '   ')
    `.execute(handle.db)).rejects.toThrow(/issue_assignees_login_not_blank|23514/);
    await expect(sql`
      INSERT INTO issue_assignees (issue_id, login)
      VALUES ('00000000-0000-4000-8000-0000000000ff'::uuid, 'cara')
    `.execute(handle.db)).rejects.toThrow(/issue_assignees_issue_id_fkey|23503/);
    const rows = await sql<{ login: string }>`SELECT login FROM issue_assignees ORDER BY login`.execute(handle.db);
    expect(rows.rows.map((row) => row.login)).toEqual(['ada', 'bob']);
  });
});
