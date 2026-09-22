import { randomUUID } from "node:crypto";
import { constants } from "../config/index.js";
import { clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import { logger } from "../infrastructure/logger.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function changedConstantKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys]
    .filter((key) => canonical(previous[key]) !== canonical(next[key]))
    .sort();
}

function currentValues(): Record<string, unknown> {
  return { ...constants };
}

/** Первая запись — базовая линия. Дальше в лог попадают только отличия. */
export async function logConstantChanges(): Promise<readonly string[]> {
  const db = getDb();
  const latest = await db
    .selectFrom("constant_revisions")
    .select(["values"])
    .orderBy("recorded_at", "desc")
    .executeTakeFirst();
  const next = currentValues();
  const previous = isRecord(latest?.values) ? latest.values : null;
  const changed = previous === null ? [] : changedConstantKeys(previous, next);
  if (previous !== null && changed.length === 0) {
    return [];
  }
  await db
    .insertInto("constant_revisions")
    .values({
      id: randomUUID(),
      recorded_at: clock.now("UTC").iso,
      values: next,
    })
    .execute();
  if (changed.length > 0) {
    logger.info("constants.changed", { changed });
  }
  return changed;
}
