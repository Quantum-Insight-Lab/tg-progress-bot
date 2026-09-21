/**
 * Generated from contracts/event-registry.yaml. Do not edit.
 * Source: npm run codegen:events
 */

export type EventEnvelope = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  actor: {
    id: string;
    role: string;
  };
  subject: {
    entity: string;
    id: string;
  };
  payload: Record<string, unknown>;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
};

export type TaskCreatedPayload = {
  task_id: string;
  project_id: string;
  issue_id: string;
  title: string;
  assignee_id: string;
  priority: "high" | "normal" | "low";
  target: "today" | "plan";
};

export type TaskPrioritizedPayload = {
  task_id: string;
  priority: "high" | "normal" | "low";
  previous_priority: "high" | "normal" | "low";
};

export type TaskReassignedPayload = {
  task_id: string;
  assignee_id: string;
  previous_assignee_id: string;
};

export type TaskPostponedPayload = {
  task_id: string;
  from_list_id: string | null;
};

export type TaskCheckedPayload = {
  task_id: string;
  list_item_id: string;
};

export type TaskUncheckedPayload = {
  task_id: string;
  list_item_id: string;
};

export type TaskConfirmedPayload = {
  task_id: string;
  confirmed_by: string;
};

export type TaskCancelledPayload = {
  task_id: string;
  cancelled_by: string;
  reason: string | null;
};

export type TaskCarriedOverPayload = {
  task_id: string;
  from_list_id: string;
  to_list_id: string;
  day_number: number;
};

export type BlockerDetectedPayload = {
  blocker_id: string;
  task_id: string;
  signal_type: "no_check" | "no_issue_activity" | "pr_stale" | "ci_red" | "no_branch";
  detected_at: string;
};

export type BlockerDeclaredPayload = {
  blocker_id: string;
  task_id: string;
  reason: string;
};

export type BlockerDismissedPayload = {
  blocker_id: string;
  task_id: string;
};

export type BlockerResolvedPayload = {
  blocker_id: string;
  task_id: string;
  resolved_by_signal: "checked" | "activity_resumed" | "ci_green" | "manual";
};

export type ProjectMemberAddedPayload = {
  project_id: string;
  user_id: string;
  role: "viewer" | "member" | "lead";
  topic_id: number | null;
};

export type ProjectMemberRemovedPayload = {
  project_id: string;
  user_id: string;
};

export type GithubIssueUpdatedPayload = {
  issue_id: string;
  issue_number: number;
  state: "open" | "closed" | "not_planned";
  title: string;
  milestone_number: number | null;
  assignee_login: string | null;
};

export type GithubIssueLinkedPayload = {
  issue_id: string;
  depends_on_issue_id: string;
  link_type: "blocked_by" | "sub_issue";
  removed: boolean;
};

export type GithubPullRequestUpdatedPayload = {
  pull_request_number: number;
  issue_id: string | null;
  state: "open" | "closed" | "merged";
  updated_at: string;
};

export type GithubChecksFailedPayload = {
  pull_request_number: number;
  conclusion: "failure" | "timed_out" | "cancelled";
  completed_at: string;
};

export type GithubMilestoneUpdatedPayload = {
  milestone_number: number;
  title: string;
  state: "open" | "closed";
  due_on: string | null;
};

export type ProgressSnapshotTakenPayload = {
  project_id: string;
  progress: number | null;
  tasks_total: number;
  tasks_done: number;
};

export type ReportSentPayload = {
  report_type: "daily" | "weekly";
  project_ids: string[];
  destination: "dm" | "group";
  chat_id: number;
  topic_id: number | null;
};

export type PayloadByType = {
  "task.created": TaskCreatedPayload;
  "task.prioritized": TaskPrioritizedPayload;
  "task.reassigned": TaskReassignedPayload;
  "task.postponed": TaskPostponedPayload;
  "task.checked": TaskCheckedPayload;
  "task.unchecked": TaskUncheckedPayload;
  "task.confirmed": TaskConfirmedPayload;
  "task.cancelled": TaskCancelledPayload;
  "task.carried_over": TaskCarriedOverPayload;
  "blocker.detected": BlockerDetectedPayload;
  "blocker.declared": BlockerDeclaredPayload;
  "blocker.dismissed": BlockerDismissedPayload;
  "blocker.resolved": BlockerResolvedPayload;
  "project.member_added": ProjectMemberAddedPayload;
  "project.member_removed": ProjectMemberRemovedPayload;
  "github.issue_updated": GithubIssueUpdatedPayload;
  "github.issue_linked": GithubIssueLinkedPayload;
  "github.pull_request_updated": GithubPullRequestUpdatedPayload;
  "github.checks_failed": GithubChecksFailedPayload;
  "github.milestone_updated": GithubMilestoneUpdatedPayload;
  "progress.snapshot_taken": ProgressSnapshotTakenPayload;
  "report.sent": ReportSentPayload;
};
