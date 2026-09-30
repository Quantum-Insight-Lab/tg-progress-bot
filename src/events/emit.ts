import { randomUUID } from 'node:crypto';
import { duplicateNoticeKey, recordsDuplicate } from './duplicate.ts';
import {
  EVENT_TYPES,
  EVENT_VERSIONS,
  EventEnvelopeSchema,
  payloadSchemaByType,
  type EventType,
  type PayloadByType,
} from './generated/events.ts';
import type { EventJournal, EventRow } from './journal.ts';

export interface EmitInput<T extends EventType> {
  type: T;
  source: string;
  idempotencyKey: string;
  payload: PayloadByType[T];
  actor: { id: string; role: string };
  subject: { entity: string; id: string };
  occurredAt: Date;
  causationId: string | null;
  correlationId: string | null;
}

export interface EmitResult {
  status: 'applied' | 'duplicate';
  row: EventRow;
}

/** Запись отклонена до журнала: схема конверта или payload не сошлась с реестром. */
export class EventRejected extends Error {
  readonly reason: 'invalid_envelope' | 'invalid_payload';

  constructor(reason: 'invalid_envelope' | 'invalid_payload', message: string) {
    super(message);
    this.name = 'EventRejected';
    this.reason = reason;
  }
}

function issues(error: { issues: readonly { message: string }[] }): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

interface PayloadParser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } };
}

function parsePayload<T extends EventType>(type: T, payload: PayloadByType[T]): PayloadByType[T] {
  // Индекс по EventType — объединение схем; разбор идёт схемой конкретного типа.
  const schema = payloadSchemaByType[type] as PayloadParser<PayloadByType[T]>;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new EventRejected('invalid_payload', issues(parsed.error));
  return parsed.data;
}

/**
 * Единственная публикация факта (INV-28). Тип — константа `EVENT_TYPES` (S-3).
 * Повтор того же `idempotencyKey` не пишет вторую строку и не меняет первую (INV-22).
 */
export async function emit<T extends EventType>(journal: EventJournal, input: EmitInput<T>): Promise<EmitResult> {
  if (input.source.length === 0 || input.idempotencyKey.length === 0) {
    throw new EventRejected('invalid_envelope', 'source и ключ идемпотентности не пустые');
  }
  if (Number.isNaN(input.occurredAt.getTime())) throw new EventRejected('invalid_envelope', 'occurred_at');
  const payload = parsePayload(input.type, input.payload);
  const envelope = {
    event_id: randomUUID(),
    event_type: input.type,
    occurred_at: input.occurredAt.toISOString(),
    actor: input.actor,
    subject: input.subject,
    payload,
    causation_id: input.causationId,
    correlation_id: input.correlationId,
    idempotency_key: input.idempotencyKey,
    schema_version: EVENT_VERSIONS[input.type],
  };
  const checked = EventEnvelopeSchema.safeParse(envelope);
  if (!checked.success) throw new EventRejected('invalid_envelope', issues(checked.error));
  const stored = await journal.append({
    id: checked.data.event_id,
    source: input.source,
    eventType: checked.data.event_type,
    payload: checked.data.payload,
    createdAt: checked.data.occurred_at,
    idempotencyKey: checked.data.idempotency_key,
    causationId: checked.data.causation_id,
    correlationId: checked.data.correlation_id,
    schemaVersion: checked.data.schema_version,
    actorId: checked.data.actor.id,
    actorRole: checked.data.actor.role,
    subjectEntity: checked.data.subject.entity,
    subjectId: checked.data.subject.id,
  });
  if (!stored.inserted && recordsDuplicate(input.type)) {
    await emit(journal, {
      type: EVENT_TYPES.DELIVERY_DUPLICATE,
      source: 'system',
      idempotencyKey: duplicateNoticeKey(input.idempotencyKey),
      payload: { source_type: input.type, source_key: input.idempotencyKey },
      actor: { id: 'system', role: 'system' },
      subject: { entity: 'Event', id: stored.row.id },
      occurredAt: input.occurredAt,
      causationId: stored.row.id,
      correlationId: input.correlationId,
    });
  }
  return { status: stored.inserted ? 'applied' : 'duplicate', row: stored.row };
}
