import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { emit } from "../../src/events/emit.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { repoRoot } from "../helpers/repo-root.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-16: UPDATE и DELETE на журнал отклоняются", async () => {
  const key = `inv16:${randomUUID()}`;
  const result = await emit(EVENT_TYPES.TASK_CHECKED, {
    actor: { id: "user-1", role: "member" },
    subject: { entity: "Task", id: "task-16" },
    payload: { task_id: "task-16", list_item_id: "item-16" },
    idempotencyKey: key,
  });

  const pool = getPool();
  await expect(
    pool.query("UPDATE events SET event_type = event_type WHERE event_id = $1", [
      result.eventId,
    ]),
  ).rejects.toThrow(/INV-16/);
  await expect(
    pool.query("DELETE FROM events WHERE event_id = $1", [result.eventId]),
  ).rejects.toThrow(/INV-16/);
});

it("INV-16: запись в events в src только через emit", () => {
  const srcRoot = join(repoRoot, "src");
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(full, "utf8");
      if (/insertInto\(\s*["']events["']\s*\)/.test(text)) {
        hits.push(relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  }

  walk(srcRoot);
  expect(hits).toEqual(["src/events/emit.ts"]);
});
