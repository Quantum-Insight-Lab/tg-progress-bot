-- Задача (E-5): шаг, который человек ведёт в Telegram.
-- Поля: номер внутри проекта, название, проект, приоритет, исполнитель, статус, даты.
-- Веса, процента задачи и внешнего ключа на зеркало GitHub нет.
-- Ключ — id. Дата завершения пуста, пока задача не завершена.
-- Допустимые значения status и priority этой миграцией не ограничиваются.
-- Уникальность number в проекте этой миграцией не задаётся.

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  priority text NOT NULL,
  assignee_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES users (id),
  CONSTRAINT tasks_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT tasks_status_not_blank CHECK (length(btrim(status)) > 0),
  CONSTRAINT tasks_priority_not_blank CHECK (length(btrim(priority)) > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tasks TO journal_app;
