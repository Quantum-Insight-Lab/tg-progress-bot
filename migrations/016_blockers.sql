-- Блокер (E-6): причина, по которой задача стоит.
-- Поля: id, задача, причина, когда спросили, когда закрыли.
-- Ключ — id. Блокеры есть только у задач (L-7).
-- Причина — ответ исполнителя и пуста, пока ответа нет.
-- Строки про CI и PR сюда не пишутся: колонок зеркала нет.
-- Открытый блокер — resolved_at пуст. Закрытие — момент выхода задачи из BLOCKED.

CREATE TABLE blockers (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  reason text,
  asked_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT blockers_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks (id),
  CONSTRAINT blockers_reason_answer CHECK (reason IS NULL OR length(btrim(reason)) > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE blockers TO journal_app;
