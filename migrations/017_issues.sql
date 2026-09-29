-- Issue (E-10): единица бэклога, из которой считается доля.
-- Поля: id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at.
-- Ключ — id. Природный ключ repository_id + issue_number этой миграцией не задаётся.
-- state — open или closed. state_reason — completed или not_planned, у открытого пусто.
-- Проекта в строке нет.

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  issue_number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  state_reason text,
  closed_by_login text,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  CONSTRAINT issues_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT issues_issue_number_positive CHECK (issue_number > 0),
  CONSTRAINT issues_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT issues_state CHECK (state IN ('open', 'closed')),
  CONSTRAINT issues_state_reason CHECK (
    state_reason IS NULL OR state_reason IN ('completed', 'not_planned')
  ),
  CONSTRAINT issues_open_without_reason CHECK (state <> 'open' OR state_reason IS NULL),
  CONSTRAINT issues_closed_by_login CHECK (
    closed_by_login IS NULL OR length(btrim(closed_by_login)) > 0
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE issues TO journal_app;
