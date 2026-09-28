-- Номер задачи уникален внутри проекта. В другом проекте тот же номер допустим.

ALTER TABLE tasks
  ADD CONSTRAINT tasks_project_number_unique UNIQUE (project_id, number);
