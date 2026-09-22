import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { constants } from "../../src/config/index.js";
import { emit, EVENT_TYPES } from "../../src/events/index.js";
import { getDb, getPool } from "../../src/infrastructure/db.js";
import {
  changedConstantKeys,
  logConstantChanges,
} from "../../src/observability/index.js";
import { rebuildProjection } from "../../src/projections/rebuild.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await getDb().deleteFrom("constant_revisions").execute();
});

it("константы: первая запись без диффа, смена staleDays логируется", async () => {
  expect(await logConstantChanges()).toEqual([]);
  const db = getDb();
  const row = await db
    .selectFrom("constant_revisions")
    .select(["id", "values"])
    .executeTakeFirstOrThrow();
  const values = { ...constants, staleDays: constants.staleDays + 1 };
  await db
    .updateTable("constant_revisions")
    .set({ values })
    .where("id", "=", row.id)
    .execute();
  expect(changedConstantKeys(values, { ...constants })).toEqual(["staleDays"]);
  expect(await logConstantChanges()).toEqual(["staleDays"]);
});

it("пересборка dynamics_series восстанавливает снимок из журнала", async () => {
  const seed = await seedProject(getPool());
  const snapshotId = randomUUID();
  await emit(EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN, {
    actor: { id: "system", role: "system" },
    subject: { entity: "ProgressSnapshot", id: snapshotId },
    payload: {
      project_id: seed.projectId,
      progress: 0.5,
      tasks_total: 2,
      tasks_done: 1,
    },
    idempotencyKey: `${seed.projectId}:2026-09-22`,
  });
  const result = await rebuildProjection("dynamics_series");
  expect(result.events).toBeGreaterThan(0);
  const row = await getDb()
    .selectFrom("progress_snapshots")
    .select(["tasks_done", "snapshot_date", "progress"])
    .where("id", "=", snapshotId)
    .executeTakeFirst();
  expect(row?.tasks_done).toBe(1);
  const stamp = row?.snapshot_date;
  const dateText =
    stamp instanceof Date
      ? `${String(stamp.getFullYear())}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`
      : String(stamp).slice(0, 10);
  expect(dateText).toBe("2026-09-22");
  expect(row?.progress).toBeCloseTo(0.5);
});
