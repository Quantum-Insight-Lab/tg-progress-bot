-- Pull request (E-14): открытый или смерженный PR с автором.
-- Поля этой миграции: id, repository_id, pull_request_number, title, author_login, state.
-- Ключ — id. Природный ключ — repository_id + pull_request_number.
-- ci_status, updated_at, merged_at и merged_by_login этой миграцией не добавляются.
-- Проекта и задачи в строке нет.

CREATE TABLE pull_requests (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  pull_request_number integer NOT NULL,
  title text NOT NULL,
  author_login text NOT NULL,
  state text NOT NULL,
  CONSTRAINT pull_requests_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT pull_requests_repository_number_unique UNIQUE (repository_id, pull_request_number),
  CONSTRAINT pull_requests_number_positive CHECK (pull_request_number > 0),
  CONSTRAINT pull_requests_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT pull_requests_author_login_not_blank CHECK (length(btrim(author_login)) > 0),
  CONSTRAINT pull_requests_state CHECK (state IN ('open', 'closed', 'merged'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pull_requests TO journal_app;
