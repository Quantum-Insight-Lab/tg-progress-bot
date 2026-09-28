import type { ColumnType } from 'kysely';

/** Колонка журнала не обновляется через типы Kysely: третья позиция `ColumnType` — `never` (INV-28). */
type AppendOnly<T> = ColumnType<T, T, never>;

export interface EventsTable {
  id: AppendOnly<string>;
  source: AppendOnly<string>;
  event_type: AppendOnly<string>;
  payload: AppendOnly<unknown>;
  created_at: AppendOnly<Date>;
  idempotency_key: AppendOnly<string>;
  causation_id: AppendOnly<string | null>;
  correlation_id: AppendOnly<string | null>;
  schema_version: AppendOnly<number>;
  actor_id: AppendOnly<string>;
  actor_role: AppendOnly<string>;
  subject_entity: AppendOnly<string>;
  subject_id: AppendOnly<string>;
}

export interface Database {
  events: EventsTable;
}
