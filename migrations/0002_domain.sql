-- Схема домена (INV-01, INV-02, INV-06, INV-07, INV-14). Журнал events — 0001.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  github_login TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  repository TEXT NOT NULL,
  timezone TEXT NOT NULL,
  telegram_chat_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  user_id UUID NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'member', 'lead')),
  topic_id BIGINT,
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS stages (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  milestone_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  due_on TIMESTAMPTZ,
  UNIQUE (project_id, milestone_number),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'not_planned')),
  assignee_login TEXT,
  stage_id UUID,
  UNIQUE (project_id, issue_number),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, stage_id) REFERENCES stages (project_id, id)
);

CREATE TABLE IF NOT EXISTS issue_dependencies (
  issue_id UUID NOT NULL REFERENCES issues (id),
  depends_on_issue_id UUID NOT NULL REFERENCES issues (id),
  link_type TEXT NOT NULL CHECK (link_type IN ('blocked_by', 'sub_issue')),
  PRIMARY KEY (issue_id, depends_on_issue_id, link_type),
  CHECK (issue_id <> depends_on_issue_id)
);

CREATE TABLE IF NOT EXISTS issue_pull_requests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  pull_request_number INTEGER NOT NULL,
  issue_id UUID REFERENCES issues (id),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  merged_at TIMESTAMPTZ,
  UNIQUE (project_id, pull_request_number)
);

CREATE TABLE IF NOT EXISTS check_runs (
  id UUID PRIMARY KEY,
  pull_request_id UUID NOT NULL REFERENCES issue_pull_requests (id),
  status TEXT NOT NULL,
  conclusion TEXT,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  issue_id UUID NOT NULL,
  assignee_id UUID NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PLANNED', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE', 'CANCELLED')
  ),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues (project_id, id),
  FOREIGN KEY (project_id, assignee_id) REFERENCES project_members (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_lists (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  list_date DATE NOT NULL,
  topic_id BIGINT,
  message_id BIGINT,
  UNIQUE (project_id, list_date),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS task_list_items (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  list_id UUID NOT NULL,
  task_id UUID NOT NULL,
  position INTEGER NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  carried_from_list_id UUID,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, list_id) REFERENCES task_lists (project_id, id),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks (project_id, id),
  FOREIGN KEY (carried_from_list_id) REFERENCES task_lists (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_list_items_one_open_per_task
  ON task_list_items (task_id)
  WHERE is_done = FALSE;

CREATE TABLE IF NOT EXISTS blockers (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks (id),
  source TEXT NOT NULL,
  signal_type TEXT CHECK (
    signal_type IN ('no_check', 'no_issue_activity', 'pr_stale', 'ci_red', 'no_branch')
  ),
  reason TEXT,
  impact TEXT,
  required_action TEXT
);

CREATE TABLE IF NOT EXISTS progress_snapshots (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  progress DOUBLE PRECISION,
  tasks_total INTEGER NOT NULL,
  tasks_done INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS report_targets (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id),
  chat_id BIGINT NOT NULL,
  topic_id BIGINT,
  report_type TEXT NOT NULL CHECK (report_type IN ('daily', 'weekly')),
  schedule_cron TEXT NOT NULL
);
