-- Снимок доли (E-16): доля бэклога проекта на сутки.
-- Поля: id, project_id, progress, created_at.
-- Ключ — id. Дата суток живёт в факте progress.snapshot_taken (проект и дата).
-- progress пуст, когда доли нет: это не ноль. Записанная строка не переписывается.

CREATE TABLE progress_snapshots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  progress double precision,
  created_at timestamptz NOT NULL,
  CONSTRAINT progress_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT progress_snapshots_progress_range CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1))
);

REVOKE ALL ON TABLE progress_snapshots FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE progress_snapshots TO journal_app;
REVOKE UPDATE, DELETE ON TABLE progress_snapshots FROM journal_app;
