-- Связь issues (E-12): blocked by или sub-issue.
-- Поля: issue_id, depends_on_issue_id, link_type.
-- Ключ — пара issues и вид связи. Проекта в строке нет.
-- issue не ссылается на себя. Очередь плана задач эту таблицу не читает.

CREATE TABLE issue_dependencies (
  issue_id uuid NOT NULL,
  depends_on_issue_id uuid NOT NULL,
  link_type text NOT NULL,
  CONSTRAINT issue_dependencies_pkey PRIMARY KEY (issue_id, depends_on_issue_id, link_type),
  CONSTRAINT issue_dependencies_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES issues (id),
  CONSTRAINT issue_dependencies_depends_on_fkey FOREIGN KEY (depends_on_issue_id) REFERENCES issues (id),
  CONSTRAINT issue_dependencies_link_type CHECK (link_type IN ('blocked_by', 'sub_issue')),
  CONSTRAINT issue_dependencies_distinct CHECK (issue_id <> depends_on_issue_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE issue_dependencies TO journal_app;
