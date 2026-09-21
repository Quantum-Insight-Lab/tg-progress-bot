import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { constants } from "../../src/config/index.js";
import { isReconcileDue } from "../../src/domain/github/index.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import { ingestGithubWebhook } from "../../src/github/ingest.js";
import type { ParsedGithubFact } from "../../src/github/parse.js";
import type { GithubReader } from "../../src/github/reader.js";
import {
  githubReconcileIntervalMs,
  reconcileGithubMirror,
  startGithubReconcileLoop,
} from "../../src/github/reconcile.js";
import { getDb, getPool } from "../../src/infrastructure/db.js";
import {
  githubSyncLag,
  resetGithubSyncForTests,
} from "../../src/observability/github-sync.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";

const webhookSecret = "webhook-secret";

async function uniqueRepo(projectId: string): Promise<string> {
  const repository = `org/${projectId.slice(0, 8)}`;
  await getPool().query("UPDATE projects SET repository = $1 WHERE id = $2", [
    repository,
    projectId,
  ]);
  return repository;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetGithubSyncForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

function signed(body: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

function trackingReader(
  facts: ParsedGithubFact[],
): GithubReader & { calls: number } {
  const reader = {
    calls: 0,
    async factsFor(): Promise<ParsedGithubFact[]> {
      reader.calls += 1;
      return facts;
    },
  };
  return reader;
}

const issueFact = (repository: string, title: string): ParsedGithubFact => ({
  kind: "issue_updated",
  repository,
  issueNumber: 4242,
  title,
  state: "open",
  assigneeLogin: "dev",
  milestoneNumber: null,
  milestone: null,
});

it("INV-08: при живом webhook сверка не плодит дубли", async () => {
  const seed = await seedProject(getPool());
  const repository = await uniqueRepo(seed.projectId);
  const rawBody = JSON.stringify({
    action: "edited",
    issue: {
      number: 4242,
      title: "Первое",
      state: "open",
      assignee: { login: "dev" },
      milestone: null,
    },
    repository: { full_name: repository },
  });
  const ingested = await ingestGithubWebhook({
    secret: webhookSecret,
    rawBody,
    signatureHeader: signed(rawBody),
    deliveryId: randomUUID(),
    eventName: "issues",
  });
  expect(ingested).toEqual({ ok: true, applied: true });

  const reader = trackingReader([issueFact(repository, "Первое")]);
  const result = await reconcileGithubMirror({
    reader,
    lastRunEpochMs: null,
    nowEpochMs: 1,
    intervalMs: githubReconcileIntervalMs(),
  });
  expect(result.ran).toBe(true);
  expect(result.applied).toBe(0);

  const issue = await getDb()
    .selectFrom("issues")
    .select("title")
    .where("project_id", "=", seed.projectId)
    .where("issue_number", "=", 4242)
    .executeTakeFirst();
  expect(issue?.title).toBe("Первое");
});

it("INV-08: сверка догоняет пропущенный webhook одним фактом", async () => {
  const seed = await seedProject(getPool());
  const repository = await uniqueRepo(seed.projectId);
  const reader = trackingReader([issueFact(repository, "С пропуска")]);
  const first = await reconcileGithubMirror({
    reader,
    lastRunEpochMs: null,
    nowEpochMs: 1,
    intervalMs: githubReconcileIntervalMs(),
  });
  expect(first.applied).toBe(1);

  const second = await reconcileGithubMirror({
    reader,
    lastRunEpochMs: null,
    nowEpochMs: githubReconcileIntervalMs() + 1,
    intervalMs: githubReconcileIntervalMs(),
  });
  expect(second.applied).toBe(0);

  const issue = await getDb()
    .selectFrom("issues")
    .select("title")
    .where("project_id", "=", seed.projectId)
    .where("issue_number", "=", 4242)
    .executeTakeFirst();
  expect(issue?.title).toBe("С пропуска");

  const events = await getDb()
    .selectFrom("events")
    .select("event_id")
    .where("event_type", "=", EVENT_TYPES.GITHUB_ISSUE_UPDATED)
    .where("idempotency_key", "like", `reconcile:${seed.projectId}:issue:4242:%`)
    .execute();
  expect(events).toHaveLength(1);
});

it("INV-08: сверка раньше C-6 не опрашивает GitHub", async () => {
  expect(constants.githubReconcileIntervalMinutes).toBe(30);
  const intervalMs = githubReconcileIntervalMs();
  const tenMinutesMs = 10 * 60 * 1000;
  expect(tenMinutesMs).toBeLessThan(intervalMs);
  expect(
    isReconcileDue({
      lastRunEpochMs: 0,
      nowEpochMs: tenMinutesMs,
      intervalMs,
    }),
  ).toBe(false);

  const reader = trackingReader([]);
  const skipped = await reconcileGithubMirror({
    reader,
    lastRunEpochMs: 0,
    nowEpochMs: tenMinutesMs,
    intervalMs,
  });
  expect(skipped).toEqual({ ran: false, applied: 0, readerCalls: 0 });
  expect(reader.calls).toBe(0);

  const due = await reconcileGithubMirror({
    reader,
    lastRunEpochMs: 0,
    nowEpochMs: intervalMs,
    intervalMs,
  });
  expect(due.ran).toBe(true);
  expect(reader.calls).toBeGreaterThan(0);
});

it("github_sync_lag: после webhook лаг меньше C-6", async () => {
  const seed = await seedProject(getPool());
  const repository = await uniqueRepo(seed.projectId);
  const rawBody = JSON.stringify({
    issue: { number: 8, title: "x", state: "open" },
    repository: { full_name: repository },
  });
  await ingestGithubWebhook({
    secret: webhookSecret,
    rawBody,
    signatureHeader: signed(rawBody),
    deliveryId: randomUUID(),
    eventName: "issues",
  });
  const lag = githubSyncLag(Date.now());
  expect(lag).not.toBeNull();
  expect(lag ?? 0).toBeLessThan(githubReconcileIntervalMs());
});

it("C-6: цикл сверки стартует явно и тикает раз в интервал", async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockResolvedValue(undefined);
  const intervalMs = githubReconcileIntervalMs();
  expect(intervalMs).toBe(constants.githubReconcileIntervalMinutes * 60 * 1000);

  const stop = startGithubReconcileLoop({ run, intervalMs });
  expect(run).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(intervalMs - 1);
  expect(run).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);

  stop();
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(run).toHaveBeenCalledTimes(2);
});
