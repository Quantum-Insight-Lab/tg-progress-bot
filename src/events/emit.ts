import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import {
  EVENT_SCHEMA_VERSIONS,
  payloadSchemas,
  type EventType,
  type PayloadByType,
} from "./generated/index.js";

export type EmitInput<T extends EventType> = {
  actor: { id: string; role: string };
  subject: { entity: string; id: string };
  payload: PayloadByType[T];
  causationId?: string | null;
  correlationId?: string | null;
  idempotencyKey: string;
};

export type EmitResult = {
  applied: boolean;
  eventId: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function jsonb(value: unknown) {
  return sql`cast(${JSON.stringify(value)} as jsonb)`;
}

export async function emit<T extends EventType>(
  type: T,
  input: EmitInput<T>,
): Promise<EmitResult> {
  payloadSchemas[type].parse(input.payload);

  const eventId = randomUUID();
  const db = getDb();

  try {
    await db
      .insertInto("events")
      .values({
        event_id: eventId,
        event_type: type,
        occurred_at: clock.now("UTC").iso,
        actor: jsonb(input.actor),
        subject: jsonb(input.subject),
        payload: jsonb(input.payload),
        causation_id: input.causationId ?? null,
        correlation_id: input.correlationId ?? null,
        idempotency_key: input.idempotencyKey,
        schema_version: EVENT_SCHEMA_VERSIONS[type],
      })
      .execute();
    return { applied: true, eventId };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existing = await db
      .selectFrom("events")
      .select("event_id")
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirst();
    if (existing === undefined) {
      throw error;
    }
    return { applied: false, eventId: existing.event_id };
  }
}
