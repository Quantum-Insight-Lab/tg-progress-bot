export type UsersTable = {
  id: string;
  telegram_user_id: string;
  github_login: string | null;
};

export type ProjectsTable = {
  id: string;
  name: string;
  repository: string;
  timezone: string;
  telegram_chat_id: string;
};

export type ProjectMembersTable = {
  id: string;
  project_id: string;
  user_id: string;
  role: "viewer" | "member" | "lead";
  topic_id: string | null;
};

export type StagesTable = {
  id: string;
  project_id: string;
  milestone_number: number;
  name: string;
  sort_order: number;
  status: "open" | "closed";
  due_on: string | null;
};

export type IssuesTable = {
  id: string;
  project_id: string;
  issue_number: number;
  title: string;
  state: "open" | "closed" | "not_planned";
  assignee_login: string | null;
  stage_id: string | null;
};

export type IssueDependenciesTable = {
  issue_id: string;
  depends_on_issue_id: string;
  link_type: "blocked_by" | "sub_issue";
};

export type IssuePullRequestsTable = {
  id: string;
  project_id: string;
  pull_request_number: number;
  issue_id: string | null;
  state: "open" | "closed" | "merged";
  merged_at: string | null;
};

export type CheckRunsTable = {
  id: string;
  pull_request_id: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
};

export type TasksTable = {
  id: string;
  project_id: string;
  issue_id: string;
  assignee_id: string;
  title: string;
  status: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
  priority: "high" | "normal" | "low";
};

export type TaskListsTable = {
  id: string;
  project_id: string;
  list_date: string;
  topic_id: string | null;
  message_id: string | null;
};

export type TaskListItemsTable = {
  id: string;
  project_id: string;
  list_id: string;
  task_id: string;
  position: number;
  is_done: boolean;
  carried_from_list_id: string | null;
};

export type BlockersTable = {
  id: string;
  task_id: string;
  source: string;
  signal_type: "no_check" | "no_issue_activity" | "pr_stale" | "ci_red" | "no_branch" | null;
  reason: string | null;
  impact: string | null;
  required_action: string | null;
};

export type ProgressSnapshotsTable = {
  id: string;
  project_id: string;
  progress: number | null;
  tasks_total: number;
  tasks_done: number;
  snapshot_date: string;
  created_at: string;
};

export type ReportTargetsTable = {
  id: string;
  project_id: string;
  chat_id: string;
  topic_id: string | null;
  report_type: "daily" | "weekly";
  schedule_cron: string;
};

export type ConstantRevisionsTable = {
  id: string;
  recorded_at: string;
  values: unknown;
};

export type EventsTable = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  actor: unknown;
  subject: unknown;
  payload: unknown;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
};

export type Database = {
  users: UsersTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  stages: StagesTable;
  issues: IssuesTable;
  issue_dependencies: IssueDependenciesTable;
  issue_pull_requests: IssuePullRequestsTable;
  check_runs: CheckRunsTable;
  tasks: TasksTable;
  task_lists: TaskListsTable;
  task_list_items: TaskListItemsTable;
  blockers: BlockersTable;
  progress_snapshots: ProgressSnapshotsTable;
  report_targets: ReportTargetsTable;
  constant_revisions: ConstantRevisionsTable;
  events: EventsTable;
};
