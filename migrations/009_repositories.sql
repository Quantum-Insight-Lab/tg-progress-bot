-- Репозиторий установки GitHub App (E-9): id, owner, name.
-- Ключ — id GitHub. Проекта в таблице нет: зеркало одно на репозиторий (INV-03).
-- default_branch_ci этой миграцией не добавляется.

CREATE TABLE repositories (
  id text PRIMARY KEY,
  owner text NOT NULL,
  name text NOT NULL,
  CONSTRAINT repositories_id_github CHECK (id ~ '^[1-9][0-9]*$'),
  CONSTRAINT repositories_owner_not_blank CHECK (length(btrim(owner)) > 0),
  CONSTRAINT repositories_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT repositories_owner_name_unique UNIQUE (owner, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE repositories TO journal_app;
