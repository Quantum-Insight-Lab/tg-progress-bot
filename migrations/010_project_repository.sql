-- Проект (L-4): не больше одного репозитория. Пусто — не подключён.
-- Один repository_id может стоять у нескольких проектов. Зеркало остаётся в repositories.
-- Уникального индекса нет: общий репозиторий не запрещён.

ALTER TABLE projects ADD COLUMN repository_id text;

ALTER TABLE projects ADD CONSTRAINT projects_repository_id_github
  CHECK (repository_id IS NULL OR repository_id ~ '^[1-9][0-9]*$');

ALTER TABLE projects ADD CONSTRAINT projects_repository_id_fkey
  FOREIGN KEY (repository_id) REFERENCES repositories (id);
