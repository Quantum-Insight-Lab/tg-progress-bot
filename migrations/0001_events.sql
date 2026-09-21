-- Журнал событий (INV-08, INV-16). Остальные таблицы — issue #5.

CREATE TABLE IF NOT EXISTS events (
  event_id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor JSONB NOT NULL,
  subject JSONB NOT NULL,
  payload JSONB NOT NULL,
  causation_id UUID,
  correlation_id UUID,
  idempotency_key TEXT,
  schema_version INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_key_uidx
  ON events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

REVOKE UPDATE, DELETE, TRUNCATE ON events FROM PUBLIC;

CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'INV-16: events journal is append-only';
END;
$$;

DROP TRIGGER IF EXISTS events_no_update_delete ON events;
CREATE TRIGGER events_no_update_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW
  EXECUTE FUNCTION events_append_only();
