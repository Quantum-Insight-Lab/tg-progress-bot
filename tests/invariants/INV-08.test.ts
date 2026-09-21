import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { emit } from "../../src/events/emit.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import { getDb } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";

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
