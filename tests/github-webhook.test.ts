import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import {
  githubWriteCommands,
  GITHUB_ACTOR_ROLE,
  GITHUB_DELIVERY_SOURCE,
  recordGithubDelivery,
  type GithubDelivery,
  type GithubDeliveryResult,
} from '../src/domain/github/delivery.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import {
  TASK_TRANSITION_CANCEL,
  TASK_TRANSITION_CHECK,
  TASK_TRANSITION_CONFIRM,
  TASK_TRANSITION_NO_BLOCKER,
  TASK_TRANSITION_PLAN,
  TASK_TRANSITION_RESUME,
  TASK_TRANSITION_RETURN,
  TASK_TRANSITION_STALE,
  TASK_TRANSITION_UNCHECK,
  transitionTask,
} from '../src/domain/tasks/transition.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook, GITHUB_WEBHOOK_PATH, verifyGithubWebhookSignature } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readCiMirrorMigration, readEventsMigration, readPullRequestsMigration, readRepositoriesMigration } from '../src/infrastructure/migrate.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const secret = 'hook-secret';
const updatedAt = '2026-09-28T07:33:00Z';
const mergedAt = '2026-09-28T08:00:00Z';

const WRITE_CALLS = [
  'issues.create',
  'issues.update',
  'issues.createComment',
  'issues.addLabels',
  'issues.removeLabel',
  'pulls.create',
  'pulls.update',
  'pulls.merge',
  'pulls.createReview',
  'repos.createCommit',
  'repos.merge',
  'actions.reRunWorkflow',
  'actions.cancelWorkflowRun',
  'checks.create',
  'checks.update',
  "method: 'POST'",
  "method: 'PATCH'",
  "method: 'PUT'",
  "method: 'DELETE'",
];

const GITHUB_BUTTONS = ['close_issue', 'close_pr', 'close_ci', 'rerun_ci', 'merge_pr'];

const TASK_ACTS = [
  TASK_TRANSITION_CHECK,
  TASK_TRANSITION_UNCHECK,
  TASK_TRANSITION_CONFIRM,
  TASK_TRANSITION_RETURN,
  TASK_TRANSITION_PLAN,
  TASK_TRANSITION_RESUME,
  TASK_TRANSITION_CANCEL,
  TASK_TRANSITION_STALE,
  TASK_TRANSITION_NO_BLOCKER,
];

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith('.ts') ? [path.split('\\').join('/')] : [];
  });
}

function sourceOf(dir: string): string {
  return filesIn(dir)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function sign(body: Buffer, key = secret): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

interface JournalHandle {
  db: Kysely<Database>;
  close(): Promise<void>;
}

async function openPullRequestJournal(): Promise<JournalHandle & { journal: ReturnType<typeof createEventJournal> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(`INSERT INTO repositories (id, owner, name) VALUES ('42', 'acme', 'bot')`);
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    journal: createEventJournal(db, silentLogger),
    async close() {
      await db.destroy();
    },
  };
}

async function openJournal(): Promise<JournalHandle & { journal: ReturnType<typeof createEventJournal> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    journal: createEventJournal(db, silentLogger),
    async close() {
      await db.destroy();
    },
  };
}

async function eventTypes(db: Kysely<Database>): Promise<string[]> {
  const rows = await db.selectFrom('events').select(['event_type']).orderBy('created_at').execute();
  return rows.map((row) => row.event_type);
}

function issueDelivery(patch: Partial<Extract<GithubDelivery, { kind: 'issues' }>> = {}): Extract<GithubDelivery, { kind: 'issues' }> {
  return {
    kind: 'issues',
    deliveryId: 'delivery-issue',
    repositoryId: '42',
    number: 12,
    title: 'Сигналы',
    state: 'closed',
    stateReason: 'completed',
    assignees: ['ada', 'bob'],
    closedByLogin: 'ada',
    updatedAt,
    isPullRequest: false,
    senderLogin: 'ada',
    ...patch,
  };
}

function pullDelivery(
  patch: Partial<Extract<GithubDelivery, { kind: 'pull_request' }>> = {},
): Extract<GithubDelivery, { kind: 'pull_request' }> {
  return {
    kind: 'pull_request',
    deliveryId: 'delivery-pr',
    repositoryId: '42',
    number: 7,
    title: 'Черновик',
    state: 'open',
    merged: false,
    authorLogin: 'outsider',
    updatedAt,
    mergedAt: null,
    mergedByLogin: null,
    senderLogin: 'editor',
    ...patch,
  };
}

function issuePayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'closed',
    issue: {
      number: 12,
      title: 'Сигналы',
      state: 'closed',
      state_reason: 'completed',
      updated_at: updatedAt,
      assignees: [{ login: 'ada' }, { login: 'bob' }, { login: 'ada' }],
      closed_by: { login: 'ada' },
      user: { login: 'ada' },
    },
    repository: { id: 42 },
    sender: { login: 'ada' },
    ...patch,
  };
}

function pullPayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'closed',
    pull_request: {
      number: 7,
      title: 'Черновик',
      state: 'closed',
      merged: true,
      updated_at: updatedAt,
      merged_at: mergedAt,
      user: { login: 'outsider' },
      merged_by: { login: 'meg' },
    },
    repository: { id: 42 },
    sender: { login: 'meg' },
    ...patch,
  };
}

describe('приём webhook GitHub', () => {
  const opened: JournalHandle[] = [];

  afterAll(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  async function journal() {
    const handle = await openJournal();
    opened.push(handle);
    return handle;
  }

  it('INV-01 pull request не становится issue, not_planned остаётся вне доли', async () => {
    const share = { completed: 2, open: 3 };
    const handle = await journal();
    const asPull = await recordGithubDelivery(handle.journal, clock, issueDelivery({ isPullRequest: true, deliveryId: 'delivery-as-pr' }));
    expect(asPull.status).toBe('ignored');
    const pull = appliedPull(
      await recordGithubDelivery(
        handle.journal,
        clock,
        pullDelivery({ deliveryId: 'delivery-merged', state: 'closed', merged: true, mergedAt, mergedByLogin: 'meg' }),
      ),
    );
    expect(pull.status).toBe('applied');
    expect(pull.payload.state).toBe('merged');
    expect(Object.keys(pull.payload)).not.toContain('state_reason');
    expect(Object.keys(pull.payload)).not.toContain('issue_number');
    const dropped = appliedIssue(
      await recordGithubDelivery(
        handle.journal,
        clock,
        issueDelivery({ deliveryId: 'delivery-dropped', state: 'closed', stateReason: 'not_planned', closedByLogin: 'ada' }),
      ),
    );
    expect(dropped.status).toBe('applied');
    expect(dropped.payload.state).toBe('closed');
    expect(dropped.payload.state_reason).toBe('not_planned');
    const reopened = appliedIssue(
      await recordGithubDelivery(
        handle.journal,
        clock,
        issueDelivery({
          deliveryId: 'delivery-open',
          state: 'open',
          stateReason: 'reopened',
          closedByLogin: 'ada',
        }),
      ),
    );
    expect(reopened.payload.state).toBe('open');
    expect(reopened.payload.state_reason).toBeNull();
    expect(reopened.payload.closed_by_login).toBeNull();
    expect(share).toEqual({ completed: 2, open: 3 });
    expect(await eventTypes(handle.db)).not.toContain(EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN);
  });

  it('INV-12 доставка pull request и CI не переводит задачи и не пишет блокер', async () => {
    const status = TASK_STATUS_IN_PROGRESS;
    const handle = await journal();
    const pullBody = Buffer.from(JSON.stringify(pullPayload()));
    const pull = await acceptGithubWebhook({
      secret,
      eventName: 'pull_request',
      deliveryId: 'delivery-pr-http',
      signature: sign(pullBody),
      body: pullBody,
      journal: handle.journal,
      clock,
    });
    expect(pull).toBe(200);
    const ciBody = Buffer.from(JSON.stringify({ action: 'completed', repository: { id: 42 } }));
    const ci = await acceptGithubWebhook({
      secret,
      eventName: 'workflow_run',
      deliveryId: 'delivery-ci',
      signature: sign(ciBody),
      body: ciBody,
      journal: handle.journal,
      clock,
    });
    expect(ci).toBe(200);
    expect(status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(() => transitionTask(status, EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED)).toThrowError(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    expect(await eventTypes(handle.db)).toEqual([EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED]);
    const github = sourceOf('src/github');
    expect(github).not.toContain('domain/tasks');
    expect(github).not.toContain('transitionTask');
    expect(github).not.toContain('TASK_STATUS_BLOCKED');
  });

  it('INV-13 логин автора PR и закрывшего issue сохраняется, чужой логин блокер не поднимает', async () => {
    const handle = await journal();
    const pull = appliedPull(await recordGithubDelivery(handle.journal, clock, pullDelivery()));
    expect(pull.status).toBe('applied');
    expect(pull.payload.author_login).toBe('outsider');
    expect(pull.payload.updated_at).toBe(updatedAt);
    expect(pull.payload.merged_at).toBeNull();
    const issue = appliedIssue(await recordGithubDelivery(handle.journal, clock, issueDelivery({ assignees: ['ada', ' ada ', 'bob', ''] })));
    expect(issue.payload.closed_by_login).toBe('ada');
    expect(issue.payload.assignees).toEqual(['ada', 'bob']);
    expect(issue.payload.updated_at).toBe(updatedAt);
    const rows = await handle.db.selectFrom('events').select(['event_type', 'actor_id', 'actor_role', 'source']).execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.event_type.startsWith('github.'))).toBe(true);
    expect(rows.every((row) => row.actor_role === GITHUB_ACTOR_ROLE)).toBe(true);
    expect(rows.every((row) => row.source === GITHUB_DELIVERY_SOURCE)).toBe(true);
    expect(rows.map((row) => row.actor_id).sort()).toEqual(['ada', 'outsider']);
    expect(rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.REPO_PR_STALLED);
    expect(rows.map((row) => row.event_type)).not.toContain(EVENT_TYPES.BLOCKER_DETECTED);
  });

  it('INV-21 в адаптере GitHub нет записи, кнопки не закрывают issue, PR и CI', () => {
    expect(githubWriteCommands()).toEqual([]);
    const github = sourceOf('src/github');
    for (const needle of WRITE_CALLS) expect(github).not.toContain(needle);
    const ui = `${sourceOf('src/telegram')}\n${sourceOf('src/projections')}`;
    for (const needle of GITHUB_BUTTONS) expect(ui).not.toContain(needle);
    for (const act of TASK_ACTS) {
      expect(GITHUB_BUTTONS).not.toContain(act);
    }
    expect(github).toContain('verifyGithubWebhookSignature');
    expect(github).not.toMatch(/env\.GITHUB_TOKEN/);
    expect(github).not.toMatch(/env\.GH_TOKEN/);
  });

  it('INV-22 повтор той же доставки не пишет второе событие и не меняет первое', async () => {
    const handle = await journal();
    const firstBody = Buffer.from(JSON.stringify(issuePayload()));
    const first = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-same',
      signature: sign(firstBody),
      body: firstBody,
      journal: handle.journal,
      clock,
    });
    const secondBody = Buffer.from(JSON.stringify(issuePayload({ issue: { ...issueBodyIssue(), title: 'Другое' } })));
    const second = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-same',
      signature: sign(secondBody),
      body: secondBody,
      journal: handle.journal,
      clock,
    });
    expect(first).toBe(200);
    expect(second).toBe(200);
    const rows = await handle.db
      .selectFrom('events')
      .select(['payload', 'idempotency_key', 'event_type'])
      .where('event_type', '=', EVENT_TYPES.GITHUB_ISSUE_CHANGED)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe('delivery-same');
    const stored = rows[0]?.payload;
    const payload = typeof stored === 'string' ? (JSON.parse(stored) as { title?: string }) : (stored as { title?: string });
    expect(payload.title).toBe('Сигналы');
    const forged = Buffer.from(JSON.stringify(issuePayload()));
    const rejected = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-forged',
      signature: sign(forged, 'other-secret'),
      body: forged,
      journal: handle.journal,
      clock,
    });
    expect(rejected).toBe(401);
    expect(await eventTypes(handle.db)).toEqual([EVENT_TYPES.GITHUB_ISSUE_CHANGED, EVENT_TYPES.DELIVERY_DUPLICATE]);
    const unsigned = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-unsigned',
      signature: undefined,
      body: forged,
      journal: handle.journal,
      clock,
    });
    expect(unsigned).toBe(401);
    expect(verifyGithubWebhookSignature(secret, forged, sign(forged))).toBe(true);
    expect(verifyGithubWebhookSignature(secret, forged, sign(Buffer.from('{}')))).toBe(false);
  });

  it('пустая подпись, битая дата и ping не пишут факт', async () => {
    const handle = await journal();
    const broken = Buffer.from(JSON.stringify(issuePayload({ issue: { ...issueBodyIssue(), updated_at: 'вчера' } })));
    const dated = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-date',
      signature: sign(broken),
      body: broken,
      journal: handle.journal,
      clock,
    });
    expect(dated).toBe(400);
    const ping = Buffer.from(JSON.stringify({ zen: 'design' }));
    const acknowledged = await acceptGithubWebhook({
      secret,
      eventName: 'ping',
      deliveryId: 'delivery-ping',
      signature: sign(ping),
      body: ping,
      journal: handle.journal,
      clock,
    });
    expect(acknowledged).toBe(200);
    expect(await eventTypes(handle.db)).toEqual([]);
  });
});

function appliedIssue(result: GithubDeliveryResult): Extract<GithubDeliveryResult, { eventType: typeof EVENT_TYPES.GITHUB_ISSUE_CHANGED }> {
  if (result.status === 'ignored' || result.eventType !== EVENT_TYPES.GITHUB_ISSUE_CHANGED) {
    throw new Error('ожидался github.issue_changed');
  }
  return result;
}

function appliedPull(
  result: GithubDeliveryResult,
): Extract<GithubDeliveryResult, { eventType: typeof EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED }> {
  if (result.status === 'ignored' || result.eventType !== EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED) {
    throw new Error('ожидался github.pull_request_changed');
  }
  return result;
}

function issueBodyIssue(): Record<string, unknown> {
  const body = issuePayload();
  const issue = body.issue;
  if (typeof issue !== 'object' || issue === null) throw new Error('issue');
  return issue as Record<string, unknown>;
}

describe('webhook GitHub в процессе', () => {
  let running: RunningProcess | undefined;
  let db: Kysely<Database> | undefined;

  afterAll(async () => {
    await running?.stop();
    await db?.destroy();
  });

  it('подписанная доставка issue публикует один факт', async () => {
    const handle = await openPullRequestJournal();
    db = handle.db;
    running = await startProcess({
      ...readProcessConfig(
        {
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
          PORT: '0',
          SCHEDULER_INTERVAL_MS: '60000',
          GITHUB_WEBHOOK_SECRET: secret,
        },
        clock,
      ),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle.db,
    });
    const raw = JSON.stringify(pullPayload());
    const status = await httpStatus(running.port, 'POST', GITHUB_WEBHOOK_PATH, raw, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-live',
      'X-Hub-Signature-256': sign(Buffer.from(raw)),
      'Content-Type': 'application/json',
    });
    expect(status).toBe(200);
    const again = await httpStatus(running.port, 'POST', GITHUB_WEBHOOK_PATH, raw, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-live',
      'X-Hub-Signature-256': sign(Buffer.from(raw)),
    });
    expect(again).toBe(200);
    const rows = await handle.db.selectFrom('events').select(['event_type', 'idempotency_key']).execute();
    expect(rows).toEqual([
      { event_type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED, idempotency_key: 'delivery-live' },
      { event_type: EVENT_TYPES.DELIVERY_DUPLICATE, idempotency_key: 'duplicate:delivery-live' },
    ]);
    const denied = await httpStatus(running.port, 'POST', GITHUB_WEBHOOK_PATH, raw, {
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': 'delivery-denied',
      'X-Hub-Signature-256': 'sha256=00',
    });
    expect(denied).toBe(401);
    expect(await handle.db.selectFrom('events').select(['id']).execute()).toHaveLength(2);
  });
});
