import { createHmac, generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_RATE_FLOOR, RECONCILE_INTERVAL } from '../src/config/constants.ts';
import type { GithubReconcileSource, RemoteMirror } from '../src/domain/github/reconcile.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createGithubReconcileSource } from '../src/github/reconcile.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import {
  readCiMirrorMigration,
  readCommitsMigration,
  readEventsMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import { reconcileGithubMirror } from '../src/infrastructure/reconcile.ts';
import { captureLog, silentLogger } from './log-lines.ts';

const moment = new Date('2026-09-30T12:00:00.000Z');
const clock: Clock = { now: () => moment };
const secret = 'log-test-github-hook-secret';
const minuteMs = 60_000;
const ISSUE_TITLE = 'Название задачи из тела доставки';
const INSTALLATION_TOKEN = 'installation-token-log-test-value';
const TOKEN_ROUTE = 'POST /app/installations/{installation_id}/access_tokens';

interface Handle {
  db: Kysely<Database>;
  close(): Promise<void>;
}

const opened: Handle[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(opened.splice(0).map((item) => item.close()));
});

async function openDb(repositories: readonly { id: string; owner: string; name: string }[] = []): Promise<Handle> {
  const pglite = new PGlite();
  for (const migration of [
    readEventsMigration(),
    readRepositoriesMigration(),
    readIssuesMigration(),
    readIssueMirrorMigration(),
    readPullRequestsMigration(),
    readCiMirrorMigration(),
    readCommitsMigration(),
  ]) {
    await pglite.exec(migration);
  }
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
  for (const repository of repositories) {
    await sql`INSERT INTO repositories (id, owner, name) VALUES (${repository.id}, ${repository.owner}, ${repository.name})`.execute(db);
  }
  const handle = { db, close: () => db.destroy() };
  opened.push(handle);
  return handle;
}

function sign(body: Buffer, key = secret): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

function issueBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'closed',
      issue: {
        number: 12,
        title: ISSUE_TITLE,
        state: 'closed',
        state_reason: 'completed',
        updated_at: '2026-09-30T11:00:00Z',
        assignees: [{ login: 'ada' }],
        closed_by: { login: 'ada' },
      },
      repository: { id: 42 },
      sender: { login: 'ada' },
    }),
  );
}

function tickingClock(stepMs: number): Clock {
  let current = moment.getTime();
  return {
    now: () => {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
  };
}

describe('B-17 логи GitHub: доставка webhook', () => {
  it('верная подпись — info: ключ доставки, событие, action, репозиторий, исход «записано в зеркало»', async () => {
    const handle = await openDb();
    const log = captureLog();
    const body = issueBody();
    let mirrored = 0;
    const status = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-ok',
      signature: sign(body),
      body,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: log.logger,
      applyIssue: async () => {
        mirrored += 1;
      },
    });
    expect(status).toBe(200);
    expect(mirrored).toBe(1);
    expect(log.lines()).toEqual([
      {
        time: moment.toISOString(),
        level: 'info',
        step: 'github.delivery',
        deliveryId: 'delivery-ok',
        githubEvent: 'issues',
        action: 'closed',
        repositoryId: '42',
        outcome: 'applied',
        eventType: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      },
    ]);
    expect(log.raw.join('\n')).not.toContain(ISSUE_TITLE);
  });

  it('INV-22 повтор той же доставки — строка повтора info, второго факта и второй записи в зеркало нет', async () => {
    const handle = await openDb();
    const log = captureLog();
    const body = issueBody();
    let mirrored = 0;
    const deliver = () =>
      acceptGithubWebhook({
        secret,
        eventName: 'issues',
        deliveryId: 'delivery-same',
        signature: sign(body),
        body,
        journal: createEventJournal(handle.db, silentLogger),
        clock,
        logger: log.logger,
        applyIssue: async () => {
          mirrored += 1;
        },
      });
    expect(await deliver()).toBe(200);
    expect(await deliver()).toBe(200);
    expect(mirrored).toBe(1);
    expect(log.steps('github.delivery')).toEqual([
      expect.objectContaining({ level: 'info', deliveryId: 'delivery-same', outcome: 'applied' }),
      expect.objectContaining({
        level: 'info',
        deliveryId: 'delivery-same',
        githubEvent: 'issues',
        repositoryId: '42',
        outcome: 'duplicate',
        eventType: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      }),
    ]);
    const issues = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events WHERE event_type = ${EVENT_TYPES.GITHUB_ISSUE_CHANGED}
    `.execute(handle.db);
    expect(Number(issues.rows[0]?.n)).toBe(1);
  });

  it('неверная и пустая подпись — warn без тела запроса и без подписи', async () => {
    const handle = await openDb();
    const log = captureLog();
    const body = issueBody();
    const forgedSignature = sign(body, 'other-secret');
    const forged = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-forged',
      signature: forgedSignature,
      body,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: log.logger,
    });
    const unsigned = await acceptGithubWebhook({
      secret,
      eventName: 'issues',
      deliveryId: 'delivery-unsigned',
      signature: undefined,
      body,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: log.logger,
    });
    expect([forged, unsigned]).toEqual([401, 401]);
    expect(log.lines()).toEqual([
      { time: moment.toISOString(), level: 'warn', step: 'github.signature_invalid', deliveryId: 'delivery-forged', githubEvent: 'issues' },
      { time: moment.toISOString(), level: 'warn', step: 'github.signature_invalid', deliveryId: 'delivery-unsigned', githubEvent: 'issues' },
    ]);
    const output = log.raw.join('\n');
    expect(output).not.toContain(ISSUE_TITLE);
    expect(output).not.toContain(body.toString('utf8'));
    expect(output).not.toContain(forgedSignature);
    expect(output).not.toContain(secret);
    const events = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM events`.execute(handle.db);
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('ping — info «пропущено»; доставка, которую не прочитать, — warn с кодом', async () => {
    const handle = await openDb();
    const log = captureLog();
    const deliver = (eventName: string | undefined, deliveryId: string, body: Buffer) =>
      acceptGithubWebhook({
        secret,
        eventName,
        deliveryId,
        signature: sign(body),
        body,
        journal: createEventJournal(handle.db, silentLogger),
        clock,
        logger: log.logger,
      });
    expect(await deliver('ping', 'delivery-ping', Buffer.from(JSON.stringify({ zen: 'design' })))).toBe(200);
    const brokenDate = JSON.parse(issueBody().toString('utf8')) as { issue: Record<string, unknown> };
    brokenDate.issue.updated_at = 'вчера';
    expect(await deliver('issues', 'delivery-date', Buffer.from(JSON.stringify(brokenDate)))).toBe(400);
    expect(await deliver(undefined, 'delivery-no-event', issueBody())).toBe(400);
    expect(await deliver('issues', 'delivery-json', Buffer.from('{'))).toBe(400);
    expect(log.steps('github.delivery')).toEqual([
      expect.objectContaining({
        level: 'info',
        deliveryId: 'delivery-ping',
        githubEvent: 'ping',
        action: null,
        repositoryId: null,
        outcome: 'ignored',
        eventType: null,
      }),
    ]);
    expect(log.steps('github.delivery_refused')).toEqual([
      expect.objectContaining({
        level: 'warn',
        deliveryId: 'delivery-date',
        githubEvent: 'issues',
        action: 'closed',
        repositoryId: '42',
        code: DOMAIN_ERROR.GITHUB_DELIVERY_DATE,
      }),
      expect.objectContaining({ level: 'warn', deliveryId: 'delivery-no-event', githubEvent: null, code: 'headers' }),
      expect.objectContaining({ level: 'warn', deliveryId: 'delivery-json', githubEvent: 'issues', code: 'json' }),
    ]);
    expect(log.raw.join('\n')).not.toContain(ISSUE_TITLE);
  });
});

function remote(patch: Partial<RemoteMirror> = {}): RemoteMirror {
  return { defaultBranch: 'main', defaultBranchCi: null, issues: [], pullRequests: [], commits: [], ...patch };
}

describe('B-17 логи GitHub: сверка по репозиторию и остаток лимита', () => {
  it('отказ одного репозитория — error по каждому, остальные — info: прочитано и восстановлено', async () => {
    const handle = await openDb([
      { id: '41', owner: 'acme', name: 'ok' },
      { id: '42', owner: 'acme', name: 'gone' },
      { id: '43', owner: 'acme', name: 'broken' },
    ]);
    const log = captureLog();
    const source: GithubReconcileSource = {
      async read(repository) {
        if (repository.id === '42') throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'репозиторий установки не прочитан');
        if (repository.id === '43') throw new Error('сеть оборвалась');
        return remote({
          defaultBranchCi: 'success',
          issues: [
            {
              number: 7,
              title: 'Дыра',
              state: 'open',
              stateReason: null,
              assignees: ['ada'],
              closedByLogin: null,
              updatedAt: '2026-09-30T11:00:00.000Z',
            },
          ],
        });
      },
    };
    await expect(reconcileGithubMirror(handle.db, log.logger, source, moment)).rejects.toThrow('репозиторий установки не прочитан');
    expect(log.steps('reconcile.repository')).toEqual([
      { time: moment.toISOString(), level: 'info', step: 'reconcile.repository', repositoryId: '41', readFacts: 2, restoredFacts: 2 },
    ]);
    expect(log.steps('reconcile.repository_failed')).toEqual([
      {
        time: moment.toISOString(),
        level: 'error',
        step: 'reconcile.repository_failed',
        repositoryId: '42',
        code: DOMAIN_ERROR.REPOSITORY_UNAVAILABLE,
        reason: 'репозиторий установки не прочитан',
      },
      {
        time: moment.toISOString(),
        level: 'error',
        step: 'reconcile.repository_failed',
        repositoryId: '43',
        code: null,
        reason: 'сеть оборвалась',
      },
    ]);
    const reconciled = await sql<{ repository_id: string }>`
      SELECT payload->>'repository_id' AS repository_id FROM events WHERE event_type = ${EVENT_TYPES.GITHUB_RECONCILED}
    `.execute(handle.db);
    expect(reconciled.rows).toEqual([{ repository_id: '41' }]);
  });

  it('остаток лимита в конце хода — info, ниже GITHUB_RATE_FLOOR — warn, отказ чтения — warn', async () => {
    const handle = await openDb();
    const readings: (number | null | Error)[] = [GITHUB_RATE_FLOOR, GITHUB_RATE_FLOOR - 1, null, new Error('лимит не прочитан')];
    const source: GithubReconcileSource = {
      async read() {
        return remote();
      },
      async rateRemainingPercent() {
        const next = readings.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    };
    const lines = [];
    for (let run = 0; run < 4; run += 1) {
      const log = captureLog();
      const now = new Date(moment.getTime() + run * RECONCILE_INTERVAL * minuteMs);
      await reconcileGithubMirror(handle.db, log.logger, source, now);
      const last = log.lines().at(-1);
      lines.push(last === undefined ? null : { level: last.level, step: last.step, remainingPercent: last.remainingPercent, reason: last.reason });
    }
    expect(lines).toEqual([
      { level: 'info', step: 'github.rate', remainingPercent: GITHUB_RATE_FLOOR, reason: undefined },
      { level: 'warn', step: 'github.rate', remainingPercent: GITHUB_RATE_FLOOR - 1, reason: undefined },
      { level: 'info', step: 'github.rate', remainingPercent: null, reason: undefined },
      { level: 'warn', step: 'github.rate_failed', remainingPercent: undefined, reason: 'лимит не прочитан' },
    ]);
    const rates = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events WHERE event_type = ${EVENT_TYPES.GITHUB_RATE_OBSERVED}
    `.execute(handle.db);
    expect(Number(rates.rows[0]?.n)).toBe(2);
  });
});

interface FakeGithub {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authorizations: string[];
  pullsStatus: number;
}

/** Страницы списков Octokit читают `url` ответа, у созданного вручную `Response` он пуст. */
function json(url: URL, status: number, body: unknown): Response {
  const response = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url.href });
  return response;
}

/** GitHub на подменённом `fetch`: установка, токен, чтения сверки и лимит. */
function fakeGithub(): FakeGithub {
  const fake: FakeGithub = {
    authorizations: [],
    pullsStatus: 200,
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      fake.authorizations.push(headers.get('authorization') ?? '');
      const path = url.pathname;
      if (path === '/app/installations') return json(url, 200, [{ id: 7, account: { login: 'acme' } }]);
      if (path === '/app/installations/7/access_tokens') {
        return json(url, 201, { token: INSTALLATION_TOKEN, expires_at: '2099-01-01T00:00:00Z', permissions: {}, repository_selection: 'all' });
      }
      if (path === '/installation/repositories') {
        return json(url, 200, {
          total_count: 1,
          repository_selection: 'all',
          repositories: [{ id: 42, name: 'bot', owner: { login: 'acme' }, default_branch: 'main' }],
        });
      }
      if (path === '/repos/acme/bot/pulls') {
        return fake.pullsStatus === 200 ? json(url, 200, []) : json(url, fake.pullsStatus, { message: 'Not Found' });
      }
      if (path === '/repos/acme/bot/issues' || path === '/repos/acme/bot/commits') return json(url, 200, []);
      if (path === '/repos/acme/bot/actions/runs') return json(url, 200, { total_count: 1, workflow_runs: [{ conclusion: 'success' }] });
      if (path === '/rate_limit') return json(url, 200, { resources: {}, rate: { limit: 5000, remaining: 500, reset: 0, used: 4500 } });
      return json(url, 404, { message: 'Not Found' });
    },
  };
  return fake;
}

describe('B-17 логи GitHub: вызов API', () => {
  it('INV-21 вызовы сверки в логе — только чтение и выпуск токена: маршрут шаблоном, код, длительность; токена и ключа App в строке нет', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyLines = privateKey.split('\n').filter((line) => line.length > 0 && !line.startsWith('-----'));
    const github = fakeGithub();
    vi.stubGlobal('fetch', github.fetch);
    const handle = await openDb([{ id: '42', owner: 'acme', name: 'bot' }]);
    const log = captureLog();
    const source = createGithubReconcileSource({ appId: '123', privateKey }, { logger: log.logger, clock: tickingClock(3) });
    await reconcileGithubMirror(handle.db, log.logger, source, moment);

    const calls = log.steps('github.api');
    const routes = [...new Set(calls.map((line) => line.route))];
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /app/installations',
        TOKEN_ROUTE,
        'GET /installation/repositories',
        'GET /repos/{owner}/{repo}/issues',
        'GET /repos/{owner}/{repo}/pulls',
        'GET /repos/{owner}/{repo}/commits',
        'GET /repos/{owner}/{repo}/actions/runs',
        'GET /rate_limit',
      ]),
    );
    expect(routes.every((route) => typeof route === 'string' && (route.startsWith('GET ') || route === TOKEN_ROUTE))).toBe(true);
    for (const line of calls) {
      expect(line.level).toBe('info');
      expect([200, 201]).toContain(line.status);
      expect(typeof line.durationMs === 'number' && line.durationMs > 0).toBe(true);
    }
    expect(log.steps('reconcile.repository')).toEqual([expect.objectContaining({ repositoryId: '42', readFacts: 1, restoredFacts: 1 })]);
    expect(log.steps('github.rate')).toEqual([expect.objectContaining({ level: 'warn', remainingPercent: 10 })]);

    github.pullsStatus = 404;
    const later = new Date(moment.getTime() + RECONCILE_INTERVAL * minuteMs);
    await expect(reconcileGithubMirror(handle.db, log.logger, source, later)).rejects.toThrow(DomainError);
    expect(log.steps('github.api').filter((line) => line.level === 'warn')).toEqual([
      expect.objectContaining({ route: 'GET /repos/{owner}/{repo}/pulls', status: 404 }),
    ]);
    expect(log.steps('reconcile.repository_failed')).toEqual([
      expect.objectContaining({ level: 'error', repositoryId: '42', code: DOMAIN_ERROR.REPOSITORY_UNAVAILABLE }),
    ]);

    expect(github.authorizations).toContain(`token ${INSTALLATION_TOKEN}`);
    const output = log.raw.join('\n');
    expect(output).not.toContain(INSTALLATION_TOKEN);
    expect(output.toLowerCase()).not.toContain('authorization');
    expect(output).not.toContain('Bearer');
    for (const line of keyLines) expect(output).not.toContain(line);
  });
});
