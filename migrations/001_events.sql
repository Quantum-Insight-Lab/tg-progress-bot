-- Журнал событий (E-17). Колонки ТЗ: id, source, event_type, payload, created_at.
-- Конверт реестра дописан ключом идемпотентности и полями причинности (INV-22, шаг 6).
-- Роль journal_app пишет только INSERT: UPDATE и DELETE сняты (INV-28).
-- Пул приложения после соединения выполняет SET ROLE journal_app.

CREATE TABLE events (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  causation_id uuid,
  correlation_id uuid,
  schema_version integer NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  subject_entity text NOT NULL,
  subject_id text NOT NULL,
  CONSTRAINT events_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT events_source_not_blank CHECK (length(source) > 0),
  CONSTRAINT events_event_type_not_blank CHECK (length(event_type) > 0),
  CONSTRAINT events_idempotency_key_not_blank CHECK (length(idempotency_key) > 0)
);

REVOKE ALL ON TABLE events FROM PUBLIC;

CREATE ROLE journal_app NOLOGIN;

GRANT SELECT, INSERT ON TABLE events TO journal_app;
REVOKE UPDATE, DELETE ON TABLE events FROM journal_app;
