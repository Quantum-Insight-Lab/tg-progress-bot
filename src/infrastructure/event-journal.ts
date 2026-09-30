import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { LogFields, Logger, LogValue } from '../domain/shared/logger.ts';
import { payloadSchemaByType } from '../events/generated/events.ts';
import type { EventJournal, EventRow } from '../events/journal.ts';
import type { Database } from './database.ts';

function text(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  throw new Error('created_at журнала не время');
}

function payloadOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  throw new Error('schema_version журнала не число');
}

function nullable(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('необязательный uuid журнала повреждён');
}

function mapRow(row: {
  id: string;
  source: string;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
  idempotency_key: string;
  causation_id: string | null;
  correlation_id: string | null;
  schema_version: number | string;
  actor_id: string;
  actor_role: string;
  subject_entity: string;
  subject_id: string;
}): EventRow {
  return {
    id: row.id,
    source: row.source,
    eventType: row.event_type,
    payload: payloadOf(row.payload),
    createdAt: text(row.created_at),
    idempotencyKey: row.idempotency_key,
    causationId: nullable(row.causation_id),
    correlationId: nullable(row.correlation_id),
    schemaVersion: numberOf(row.schema_version),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
  };
}

/** Строка без enum в схеме попадает в лог, только если по имени это ID: `task_id`, `lead_ids`, `confirmed_by`. */
const ID_FIELD = /(^|_)(id|ids|by)$/;

/**
 * ID и коды payload по схеме реестра: enum, числа, флаги, строки-ID.
 * Прочие строки — название, причина, аргумент команды, логин — в лог не идут ни на каком уровне.
 */
function isIdOrCode(key: string, field: z.core.$ZodType): boolean {
  if (field instanceof z.ZodUnion) return field.options.every((option) => option instanceof z.ZodNull || isIdOrCode(key, option));
  if (field instanceof z.ZodArray) return isIdOrCode(key, field.element);
  if (field instanceof z.ZodEnum || field instanceof z.ZodNumber || field instanceof z.ZodBoolean) return true;
  return field instanceof z.ZodString && ID_FIELD.test(key);
}

const LOGGED_PAYLOAD_KEYS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(payloadSchemaByType).map(([type, schema]) => [
    type,
    Object.entries(schema.shape)
      .filter(([key, field]) => isIdOrCode(key, field))
      .map(([key]) => key),
  ]),
);

function logValue(value: unknown): LogValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) return value.map(String);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadFields(row: EventRow): Record<string, LogValue> {
  const fields: Record<string, LogValue> = {};
  if (!isRecord(row.payload)) return fields;
  for (const key of LOGGED_PAYLOAD_KEYS.get(row.eventType) ?? []) {
    const value = logValue(row.payload[key]);
    if (value !== undefined) fields[`payload.${key}`] = value;
  }
  return fields;
}

function envelopeFields(row: EventRow): LogFields {
  return {
    eventId: row.id,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    idempotencyKey: row.idempotencyKey,
    subjectEntity: row.subjectEntity,
    subjectId: row.subjectId,
    correlationId: row.correlationId,
    causationId: row.causationId,
  };
}

async function appendRow(db: Kysely<Database>, row: EventRow): Promise<{ inserted: boolean; row: EventRow }> {
  const inserted = await db
    .insertInto('events')
    .values({
      id: row.id,
      source: row.source,
      event_type: row.eventType,
      payload: JSON.stringify(row.payload),
      created_at: new Date(row.createdAt),
      idempotency_key: row.idempotencyKey,
      causation_id: row.causationId,
      correlation_id: row.correlationId,
      schema_version: row.schemaVersion,
      actor_id: row.actorId,
      actor_role: row.actorRole,
      subject_entity: row.subjectEntity,
      subject_id: row.subjectId,
    })
    .onConflict((conflict) => conflict.column('idempotency_key').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { inserted: true, row: mapRow(inserted) };
  const existing = await db.selectFrom('events').selectAll().where('idempotency_key', '=', row.idempotencyKey).executeTakeFirst();
  if (!existing) throw new Error('событие не записано и не найдено по ключу идемпотентности');
  return { inserted: false, row: mapRow(existing) };
}

/**
 * Запись журнала. Конфликт ключа идемпотентности не переписывает строку (INV-22).
 * Строка лога на каждую попытку: записано — `info`, повтор по ключу — `info` с ID лежащего факта,
 * отказ схемы — `warn`, отказ записи — `error`. Payload остаётся в БД: в лог идут только ID и коды.
 */
export function createEventJournal(db: Kysely<Database>, logger: Logger): EventJournal {
  return {
    async append(row) {
      let stored: { inserted: boolean; row: EventRow };
      try {
        stored = await appendRow(db, row);
      } catch (error) {
        logger.error('event.append_failed', { eventType: row.eventType, idempotencyKey: row.idempotencyKey }, error);
        throw error;
      }
      if (stored.inserted) logger.info('event.recorded', { ...envelopeFields(stored.row), ...payloadFields(stored.row) });
      else logger.info('event.duplicate', { ...envelopeFields(row), eventId: stored.row.id });
      return stored;
    },
    refuse(event) {
      logger.warn('event.refused', { eventType: event.eventType, paths: event.paths, codes: event.codes });
    },
  };
}
