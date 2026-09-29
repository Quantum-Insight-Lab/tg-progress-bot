-- Природный ключ issue (L-10): репозиторий и номер, не проект.
-- Assignee (E-11): issue_id и login. Зеркало назначений заполняется отдельным актом.

ALTER TABLE issues
  ADD CONSTRAINT issues_repository_number_unique UNIQUE (repository_id, issue_number);

CREATE TABLE issue_assignees (
  issue_id uuid NOT NULL,
  login text NOT NULL,
  CONSTRAINT issue_assignees_pkey PRIMARY KEY (issue_id, login),
  CONSTRAINT issue_assignees_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES issues (id),
  CONSTRAINT issue_assignees_login_not_blank CHECK (length(btrim(login)) > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE issue_assignees TO journal_app;
