CREATE TABLE IF NOT EXISTS constant_revisions (
  id UUID PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL,
  values JSONB NOT NULL
);
