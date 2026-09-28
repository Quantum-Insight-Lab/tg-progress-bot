/** Строка журнала. `createdAt` — `occurred_at` конверта: в таблице это колонка `created_at` (R-933). */
export interface EventRow {
  id: string;
  source: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
  idempotencyKey: string;
  causationId: string | null;
  correlationId: string | null;
  schemaVersion: number;
  actorId: string;
  actorRole: string;
  subjectEntity: string;
  subjectId: string;
}

/** Единственная запись в журнал — `append`. Повтор ключа возвращает уже лежащую строку и ничего не меняет (INV-22). */
export interface EventJournal {
  append(row: EventRow): Promise<{ inserted: boolean; row: EventRow }>;
}
