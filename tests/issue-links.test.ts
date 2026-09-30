import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { githubWriteCommands, type IssueDelivery } from '../src/domain/github/delivery.ts';
import { issueAssigneeSet } from '../src/domain/github/issue-assignee.ts';
import { defineIssueDependency, ISSUE_LINK_BLOCKED_BY, ISSUE_LINK_SUB_ISSUE } from '../src/domain/github/issue-dependency.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { orderPlan, TASK_PRIORITY_HIGH, TASK_PRIORITY_LOW, TASK_STATUS_IN_PROGRESS, TASK_STATUS_PLANNED } from '../src/domain/tasks/status.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { mirrorGithubIssueLink } from '../src/infrastructure/issue-links.ts';
import { mirrorGithubIssue } from '../src/infrastructure/issue-mirror.ts';
import {
  readEventsMigration,
  readIssueDependenciesMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const repositoryId = '42';
const updatedAt = '2026-09-28T07:33:00.000Z';
const secret = 'hook-secret';
const issueId = '00000000-0000-4000-8000-0000000000f1';

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

function issueDelivery(patch: Partial<IssueDelivery> = {}): IssueDelivery {
  return {
    kind: 'issues',
    deliveryId: 'delivery-issue',
    repositoryId,
    number: 12,
    title: 'Сигналы',
    state: 'open',
    stateReason: null,
    assignees: ['ada'],
    closedByLogin: null,
    updatedAt,
    isPullRequest: false,
    senderLogin: 'ada',
    ...patch,
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
  await pglite.exec(readIssueDependenciesMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  await sql`INSERT INTO repositories (id, owner, name) VALUES (${repositoryId}, 'acme', 'bot')`.execute(db);
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function deliverIssue(db: Kysely<Database>, delivery: IssueDelivery): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      action: 'opened',
      issue: {
        number: delivery.number,
        title: delivery.title,
        state: delivery.state,
        state_reason: delivery.stateReason,
        updated_at: delivery.updatedAt,
        assignees: delivery.assignees.map((login) => ({ login })),
      },
      repository: { id: Number(delivery.repositoryId) },
      sender: { login: delivery.senderLogin },
    }),
  );
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  await db.transaction().execute(async (trx) => {
    const status = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: delivery.deliveryId,
      signature,
      body,
      journal: createEventJournal(trx, silentLogger),
      clock,
      logger: silentLogger,
      applyIssue: async (payload) => {
        await mirrorGithubIssue(trx, payload, randomUUID());
      },
    });
    expect(status).toBe(200);
  });
}

async function deliverLink(
  db: Kysely<Database>,
  eventName: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return db.transaction().execute((trx) =>
    acceptGithubWebhook({
      secret,
      eventName,
      deliveryId,
      signature,
      body,
      journal: createEventJournal(trx, silentLogger),
      clock,
      logger: silentLogger,
      applyIssueLink: async (fact) => {
        await mirrorGithubIssueLink(trx, fact);
      },
    }),
  );
}

async function links(db: Kysely<Database>): Promise<{ issue_number: number; depends_on: number; link_type: string }[]> {
  const rows = await sql<{ issue_number: number; depends_on: number; link_type: string }>`
    SELECT i.issue_number, d.issue_number AS depends_on, l.link_type
    FROM issue_dependencies AS l
    JOIN issues AS i ON i.id = l.issue_id
    JOIN issues AS d ON d.id = l.depends_on_issue_id
    ORDER BY l.link_type, i.issue_number, d.issue_number
  `.execute(db);
  return rows.rows;
}

async function assignees(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ login: string }>`SELECT login FROM issue_assignees ORDER BY login`.execute(db);
  return rows.rows.map((row) => row.login);
}

async function eventCount(db: Kysely<Database>, eventType: string): Promise<number> {
  const count = await sql<{ n: number }>`
    SELECT CAST(count(*) AS int) AS n FROM events WHERE event_type = ${eventType}
  `.execute(db);
  return Number(count.rows[0]?.n);
}

describe('зеркало assignees и связей issues', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-21 зеркало assignees и связей не пишет в GitHub', () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = [
      readFileSync('src/github/webhook.ts', 'utf8'),
      readFileSync('src/domain/github/issue-assignee.ts', 'utf8'),
      readFileSync('src/domain/github/issue-dependency.ts', 'utf8'),
      readFileSync('src/domain/github/issue-link.ts', 'utf8'),
      readFileSync('src/infrastructure/issue-mirror.ts', 'utf8'),
      readFileSync('src/infrastructure/issue-links.ts', 'utf8'),
    ].join('\n');
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
  });

  it('INV-22 повтор доставки не меняет assignees и не снимает связь', async () => {
    const handle = await openMirror();
    opened.push(handle);
    await deliverIssue(handle.db, issueDelivery({ assignees: ['ada', 'bob'] }));
    await deliverIssue(handle.db, issueDelivery({ number: 4, deliveryId: 'delivery-other', title: 'Блок', assignees: [] }));
    expect(await assignees(handle.db)).toEqual(['ada', 'bob']);
    await deliverIssue(handle.db, issueDelivery({ deliveryId: 'delivery-issue', assignees: [] }));
    expect(await assignees(handle.db)).toEqual(['ada', 'bob']);
    expect(await eventCount(handle.db, EVENT_TYPES.GITHUB_ISSUE_CHANGED)).toBe(2);
    const blocked = {
      action: 'blocked_by_added',
      blocked_issue: { number: 12 },
      blocking_issue: { number: 4 },
      blocking_issue_repo: { id: 42 },
      repository: { id: 42 },
      sender: { login: 'ada' },
    };
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-link', blocked)).toBe(200);
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-link', { ...blocked, action: 'blocked_by_removed' })).toBe(200);
    expect(await links(handle.db)).toEqual([{ issue_number: 12, depends_on: 4, link_type: 'blocked_by' }]);
    expect(await eventCount(handle.db, EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED)).toBe(1);
  });

  it('несколько assignees одного issue и снятие лишнего логина', async () => {
    expect(issueAssigneeSet(issueId, [' ada ', 'bob', 'ada'])).toEqual([
      { issueId, login: 'ada' },
      { issueId, login: 'bob' },
    ]);
    expect(() => issueAssigneeSet(' ', ['ada'])).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ID_BLANK }));
    const handle = await openMirror();
    opened.push(handle);
    await deliverIssue(handle.db, issueDelivery({ assignees: ['ada', 'bob'] }));
    expect(await assignees(handle.db)).toEqual(['ada', 'bob']);
    await deliverIssue(handle.db, issueDelivery({ deliveryId: 'delivery-unassign', assignees: ['bob'] }));
    expect(await assignees(handle.db)).toEqual(['bob']);
    await deliverIssue(handle.db, issueDelivery({ deliveryId: 'delivery-clear', assignees: [] }));
    expect(await assignees(handle.db)).toEqual([]);
  });

  it('blocked by и sub-issue хранятся в зеркале, очередь плана их не читает', async () => {
    expect(defineIssueDependency({
      issueId,
      dependsOnIssueId: '00000000-0000-4000-8000-0000000000f2',
      linkType: ISSUE_LINK_BLOCKED_BY,
    }).linkType).toBe(ISSUE_LINK_BLOCKED_BY);
    expect(() => defineIssueDependency({ issueId, dependsOnIssueId: issueId, linkType: ISSUE_LINK_SUB_ISSUE })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_LINK_SELF }),
    );
    expect(() => defineIssueDependency({
      issueId,
      dependsOnIssueId: '00000000-0000-4000-8000-0000000000f2',
      linkType: 'relates_to',
    })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_LINK_TYPE }));
    const planSource = `${readFileSync('src/domain/tasks/status.ts', 'utf8')}\n${readFileSync('src/projections/plan-block.ts', 'utf8')}`;
    expect(planSource).not.toContain('issue_dependencies');
    const queued = [
      { status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_LOW, createdAt: '2026-09-01T00:00:00.000Z' },
      { status: TASK_STATUS_PLANNED, priority: TASK_PRIORITY_HIGH, createdAt: '2026-09-02T00:00:00.000Z' },
      { status: TASK_STATUS_IN_PROGRESS, priority: TASK_PRIORITY_HIGH, createdAt: '2026-09-01T00:00:00.000Z' },
    ] as const;
    expect(orderPlan(queued).map((task) => task.priority)).toEqual([TASK_PRIORITY_HIGH, TASK_PRIORITY_LOW]);
    const handle = await openMirror();
    opened.push(handle);
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-early', {
      action: 'blocked_by_added',
      blocked_issue: { number: 12 },
      blocking_issue: { number: 4 },
      blocking_issue_repo: { id: 42 },
      repository: { id: 42 },
      sender: { login: 'ada' },
    })).toBe(200);
    expect(await links(handle.db)).toEqual([]);
    expect(await eventCount(handle.db, EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED)).toBe(1);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issue_dependencies'
      ORDER BY column_name
    `.execute(handle.db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['depends_on_issue_id', 'issue_id', 'link_type']);
    await deliverIssue(handle.db, issueDelivery());
    await deliverIssue(handle.db, issueDelivery({ number: 4, deliveryId: 'delivery-dep', title: 'Блок', assignees: [] }));
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-before', {
      action: 'blocked_by_added',
      repository: { id: 42 },
    })).toBe(200);
    expect(await links(handle.db)).toEqual([]);
    expect(await eventCount(handle.db, EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED)).toBe(1);
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-blocked', {
      action: 'blocking_added',
      blocked_issue: { number: 12 },
      blocking_issue: { number: 4 },
      blocking_issue_repo: { id: 42 },
      repository: { id: 42 },
      sender: { login: 'ada' },
    })).toBe(200);
    expect(await deliverLink(handle.db, 'sub_issues', 'delivery-sub', {
      action: 'parent_issue_added',
      parent_issue: { number: 12 },
      sub_issue: { number: 4 },
      parent_issue_repo: { id: 42 },
      repository: { id: 42 },
      sender: { login: 'ada' },
    })).toBe(200);
    expect(await links(handle.db)).toEqual([
      { issue_number: 12, depends_on: 4, link_type: 'blocked_by' },
      { issue_number: 12, depends_on: 4, link_type: 'sub_issue' },
    ]);
    expect(orderPlan(queued).map((task) => task.priority)).toEqual([TASK_PRIORITY_HIGH, TASK_PRIORITY_LOW]);
    expect(await deliverLink(handle.db, 'issue_dependencies', 'delivery-foreign', {
      action: 'blocked_by_added',
      blocked_issue: { number: 12 },
      blocking_issue: { number: 9 },
      blocking_issue_repo: { id: 7 },
      repository: { id: 42 },
    })).toBe(200);
    expect(await eventCount(handle.db, EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED)).toBe(3);
    expect(await deliverLink(handle.db, 'sub_issues', 'delivery-sub-off', {
      action: 'sub_issue_removed',
      parent_issue: { number: 12 },
      sub_issue: { number: 4 },
      parent_issue_repo: { id: 42 },
      repository: { id: 42 },
    })).toBe(200);
    expect(await links(handle.db)).toEqual([{ issue_number: 12, depends_on: 4, link_type: 'blocked_by' }]);
    const stored = await sql<{ id: string }>`SELECT id::text AS id FROM issues WHERE issue_number = 12`.execute(handle.db);
    const id = stored.rows[0]?.id ?? issueId;
    await expect(sql`
      INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, link_type)
      VALUES (${id}::uuid, ${id}::uuid, 'blocked_by')
    `.execute(handle.db)).rejects.toThrow(/issue_dependencies_distinct|23514/);
    await expect(sql`
      INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, link_type)
      VALUES (${id}::uuid, '00000000-0000-4000-8000-0000000000ff'::uuid, 'blocked_by')
    `.execute(handle.db)).rejects.toThrow(/issue_dependencies_depends_on_fkey|23503/);
    await expect(sql`
      INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, link_type)
      VALUES (${id}::uuid, ${id}::uuid, 'relates_to')
    `.execute(handle.db)).rejects.toThrow(/issue_dependencies_link_type|issue_dependencies_distinct|23514/);
  });
});
