import type { Kysely } from 'kysely';
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

/** Запись журнала. Конфликт ключа идемпотентности не переписывает строку (INV-22). */
export function createEventJournal(db: Kysely<Database>): EventJournal {
  return {
    async append(row) {
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
    },
  };
}
