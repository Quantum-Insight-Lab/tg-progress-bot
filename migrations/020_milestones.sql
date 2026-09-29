-- Milestone (E-13): факт GitHub с названием и сроком.
-- Поля: id, repository_id, milestone_number, title, state, due_on.
-- Ключ — id. Природный ключ — repository_id + milestone_number.
-- Проекта и задачи в строке нет: это не этап задач.

CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  milestone_number integer NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  due_on date,
  CONSTRAINT milestones_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES repositories (id),
  CONSTRAINT milestones_repository_number_unique UNIQUE (repository_id, milestone_number),
  CONSTRAINT milestones_number_positive CHECK (milestone_number > 0),
  CONSTRAINT milestones_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT milestones_state CHECK (state IN ('open', 'closed'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE milestones TO journal_app;
