-- Проект (E-3): единица людей и учёта.
-- Своё у проекта — задачи и роли (L-5): в этой таблице их нет, ключ учёта — id.
-- repository_id этой миграцией не добавляется.
-- chat_id пуст, пока супергруппа не привязана, и не уникален: ключ проекта — только id.

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  timezone text NOT NULL,
  chat_id uuid,
  created_at timestamptz NOT NULL,
  CONSTRAINT projects_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_timezone_not_blank CHECK (length(btrim(timezone)) > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE projects TO journal_app;
