-- Участник проекта (E-4): пользователь в проекте с ролью.
-- topic_id этой миграцией не добавляется.
-- Роли две: member и lead. Роли «только просмотр» нет (INV-18).
-- Уникально project_id + user_id.

CREATE TABLE project_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT project_members_role CHECK (role IN ('member', 'lead')),
  CONSTRAINT project_members_project_user_unique UNIQUE (project_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE project_members TO journal_app;
