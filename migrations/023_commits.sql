-- Коммит (E-15): хвост коммитов репозитория, не журнал всей истории.
-- Поля: id, repository_id, sha, message, author_login, created_at.
-- Ключ — id. Природный ключ — repository_id + sha.
-- Проекта и задачи в строке нет. Окно хвоста считает домен, не эта таблица.

CREATE TABLE commits (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  sha text NOT NULL,
  message text NOT NULL,
  author_login text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT commits_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT commits_repository_sha_unique UNIQUE (repository_id, sha),
  CONSTRAINT commits_sha_not_blank CHECK (length(btrim(sha)) > 0),
  CONSTRAINT commits_message_not_blank CHECK (length(btrim(message)) > 0),
  CONSTRAINT commits_author_login_not_blank CHECK (length(btrim(author_login)) > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commits TO journal_app;
