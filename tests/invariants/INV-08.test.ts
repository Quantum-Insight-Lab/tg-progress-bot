import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { emit } from "../../src/events/emit.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import { ingestGithubWebhook } from "../../src/github/ingest.js";
import { getDb, getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-08: повторная доставка с тем же ключом не создаёт второго события", async () => {
  const key = `callback:${randomUUID()}`;
  const input = {
    actor: { id: "user-1", role: "member" },
    subject: { entity: "Task", id: "task-1" },
    payload: { task_id: "task-1", list_item_id: "item-1" },
    idempotencyKey: key,
  };

  const first = await emit(EVENT_TYPES.TASK_CHECKED, input);
  const second = await emit(EVENT_TYPES.TASK_CHECKED, {
    ...input,
    payload: { task_id: "task-1", list_item_id: "other-item" },
  });

  expect(first.applied).toBe(true);
  expect(second.applied).toBe(false);
  expect(second.eventId).toBe(first.eventId);

  const rows = await getDb()
    .selectFrom("events")
    .select(["event_id", "payload"])
    .where("idempotency_key", "=", key)
    .execute();

  expect(rows).toHaveLength(1);
  expect(rows[0]?.payload).toEqual({ task_id: "task-1", list_item_id: "item-1" });
});

const webhookSecret = "webhook-secret";

function signed(body: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

async function deliver(input: {
  eventName: string;
  deliveryId: string;
  body: unknown;
}): Promise<Awaited<ReturnType<typeof ingestGithubWebhook>>> {
  const rawBody = JSON.stringify(input.body);
  return ingestGithubWebhook({
    secret: webhookSecret,
    rawBody,
    signatureHeader: signed(rawBody),
    deliveryId: input.deliveryId,
    eventName: input.eventName,
  });
}

it("INV-08: повтор webhook с тем же delivery_id не меняет зеркало", async () => {
  const seed = await seedProject(getPool());
  const deliveryId = randomUUID();
  const firstBody = {
    action: "edited",
    issue: {
      number: 4242,
      title: "Первое",
      state: "open",
      assignee: { login: "dev" },
      milestone: null,
    },
    repository: { full_name: "org/repo" },
  };
  const first = await deliver({
    eventName: "issues",
    deliveryId,
    body: firstBody,
  });
  expect(first).toEqual({ ok: true, applied: true });

  const second = await deliver({
    eventName: "issues",
    deliveryId,
    body: { ...firstBody, issue: { ...firstBody.issue, title: "Второе" } },
  });
  expect(second).toEqual({ ok: true, applied: false });

  const issue = await getDb()
    .selectFrom("issues")
    .select(["title", "state"])
    .where("project_id", "=", seed.projectId)
    .where("issue_number", "=", 4242)
    .executeTakeFirst();
  expect(issue).toEqual({ title: "Первое", state: "open" });

  const events = await getDb()
    .selectFrom("events")
    .select("event_type")
    .where("idempotency_key", "=", `${deliveryId}:${seed.projectId}`)
    .execute();
  expect(events).toEqual([{ event_type: EVENT_TYPES.GITHUB_ISSUE_UPDATED }]);
});

it("INV-08: неверная подпись webhook не создаёт события", async () => {
  await seedProject(getPool());
  const rawBody = JSON.stringify({
    issue: { number: 1, title: "x", state: "open" },
    repository: { full_name: "org/repo" },
  });
  const result = await ingestGithubWebhook({
    secret: webhookSecret,
    rawBody,
    signatureHeader: "sha256=deadbeef",
    deliveryId: randomUUID(),
    eventName: "issues",
  });
  expect(result).toEqual({ ok: false, reason: "invalid_signature" });
});

it("INV-08: webhook PR, checks, milestone и sub-issue пишут зеркало один раз", async () => {
  const seed = await seedProject(getPool());
  const prDelivery = randomUUID();
  const checkDelivery = randomUUID();
  const mileDelivery = randomUUID();
  const linkDelivery = randomUUID();

  const pr = await deliver({
    eventName: "pull_request",
    deliveryId: prDelivery,
    body: {
      action: "closed",
      pull_request: {
        number: 7,
        state: "closed",
        merged: true,
        merged_at: "2026-09-21T01:00:00Z",
        updated_at: "2026-09-21T01:00:00Z",
      },
      repository: { full_name: "org/repo" },
    },
  });
  expect(pr).toEqual({ ok: true, applied: true });
  expect(
    await deliver({
      eventName: "pull_request",
      deliveryId: prDelivery,
      body: {
        action: "closed",
        pull_request: {
          number: 7,
          state: "closed",
          merged: true,
          merged_at: "2026-09-21T01:00:00Z",
          updated_at: "2026-09-21T02:00:00Z",
        },
        repository: { full_name: "org/repo" },
      },
    }),
  ).toEqual({ ok: true, applied: false });

  const prRow = await getDb()
    .selectFrom("issue_pull_requests")
    .select(["state", "pull_request_number"])
    .where("project_id", "=", seed.projectId)
    .where("pull_request_number", "=", 7)
    .executeTakeFirst();
  expect(prRow).toEqual({ state: "merged", pull_request_number: 7 });

  const checks = await deliver({
    eventName: "check_run",
    deliveryId: checkDelivery,
    body: {
      action: "completed",
      check_run: {
        conclusion: "failure",
        completed_at: "2026-09-21T03:00:00Z",
        pull_requests: [{ number: 7 }],
      },
      repository: { full_name: "org/repo" },
    },
  });
  expect(checks).toEqual({ ok: true, applied: true });
  expect(
    await deliver({
      eventName: "check_run",
      deliveryId: checkDelivery,
      body: {
        action: "completed",
        check_run: {
          conclusion: "failure",
          completed_at: "2026-09-21T04:00:00Z",
          pull_requests: [{ number: 7 }],
        },
        repository: { full_name: "org/repo" },
      },
    }),
  ).toEqual({ ok: true, applied: false });

  const checkRows = await getDb()
    .selectFrom("check_runs")
    .innerJoin(
      "issue_pull_requests",
      "issue_pull_requests.id",
      "check_runs.pull_request_id",
    )
    .select("check_runs.id as id")
    .where("issue_pull_requests.project_id", "=", seed.projectId)
    .where("issue_pull_requests.pull_request_number", "=", 7)
    .execute();
  expect(checkRows).toHaveLength(1);

  const mile = await deliver({
    eventName: "milestone",
    deliveryId: mileDelivery,
    body: {
      action: "edited",
      milestone: {
        number: 3,
        title: "M3",
        state: "open",
        due_on: "2026-10-01T00:00:00Z",
      },
      repository: { full_name: "org/repo" },
    },
  });
  expect(mile).toEqual({ ok: true, applied: true });

  const stage = await getDb()
    .selectFrom("stages")
    .select(["name", "milestone_number"])
    .where("project_id", "=", seed.projectId)
    .where("milestone_number", "=", 3)
    .executeTakeFirst();
  expect(stage).toEqual({ name: "M3", milestone_number: 3 });

  const linked = await deliver({
    eventName: "sub_issues",
    deliveryId: linkDelivery,
    body: {
      action: "added",
      parent_issue: { number: 10, title: "Parent", state: "open" },
      sub_issue: { number: 11, title: "Child", state: "open" },
      repository: { full_name: "org/repo" },
    },
  });
  expect(linked).toEqual({ ok: true, applied: true });
  expect(
    await deliver({
      eventName: "sub_issues",
      deliveryId: linkDelivery,
      body: {
        action: "removed",
        parent_issue: { number: 10, title: "Parent", state: "open" },
        sub_issue: { number: 11, title: "Child", state: "open" },
        repository: { full_name: "org/repo" },
      },
    }),
  ).toEqual({ ok: true, applied: false });

  const deps = await getDb()
    .selectFrom("issue_dependencies")
    .innerJoin("issues", "issues.id", "issue_dependencies.issue_id")
    .select("issue_dependencies.link_type as link_type")
    .where("issues.project_id", "=", seed.projectId)
    .execute();
  expect(deps).toEqual([{ link_type: "sub_issue" }]);
});
