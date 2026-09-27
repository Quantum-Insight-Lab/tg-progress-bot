// Сгенерировано из contracts/event-registry.yaml командой npm run codegen:events. Руками не править (S-3).

export const EVENT_TYPES = {
  TASK_CREATED: 'task.created',
  TASK_CHECKED: 'task.checked',
  TASK_UNCHECKED: 'task.unchecked',
  TASK_CONFIRMED: 'task.confirmed',
  TASK_RETURNED: 'task.returned',
  TASK_PLANNED: 'task.planned',
  TASK_RESUMED: 'task.resumed',
  TASK_PRIORITIZED: 'task.prioritized',
  TASK_CANCELLED: 'task.cancelled',
  BLOCKER_DETECTED: 'blocker.detected',
  BLOCKER_DECLARED: 'blocker.declared',
  BLOCKER_DISMISSED: 'blocker.dismissed',
  REVIEW_REMINDED: 'review.reminded',
  CANVAS_POSTED: 'canvas.posted',
  CANVAS_EDITED: 'canvas.edited',
  CANVAS_FULL: 'canvas.full',
  CANVAS_CARRIED_OVER: 'canvas.carried_over',
  DIVERGENCE_DETECTED: 'divergence.detected',
  USER_REGISTERED: 'user.registered',
  USER_GITHUB_LOGIN_SET: 'user.github_login_set',
  PROJECT_CREATED: 'project.created',
  PROJECT_CHAT_BOUND: 'project.chat_bound',
  PROJECT_REPOSITORY_CONNECTED: 'project.repository_connected',
  PROJECT_REPOSITORY_CHANGED: 'project.repository_changed',
  PROJECT_SETTINGS_CHANGED: 'project.settings_changed',
  PROJECT_MEMBER_ADDED: 'project.member_added',
  PROJECT_MEMBER_REMOVED: 'project.member_removed',
  MEMBER_TOPIC_SET: 'member.topic_set',
  CHAT_REPORTS_TOPIC_SET: 'chat.reports_topic_set',
  CHAT_SCHEDULE_SET: 'chat.schedule_set',
  CHAT_SCHEDULE_CLEARED: 'chat.schedule_cleared',
  ACCESS_DENIED: 'access.denied',
  GITHUB_ISSUE_CHANGED: 'github.issue_changed',
  GITHUB_PULL_REQUEST_CHANGED: 'github.pull_request_changed',
  GITHUB_COMMITS_PUSHED: 'github.commits_pushed',
  GITHUB_WORKFLOW_COMPLETED: 'github.workflow_completed',
  GITHUB_MILESTONE_CHANGED: 'github.milestone_changed',
  GITHUB_ISSUE_LINKS_CHANGED: 'github.issue_links_changed',
  GITHUB_RECONCILED: 'github.reconciled',
  REPO_PR_STALLED: 'repo.pr_stalled',
  PROGRESS_SNAPSHOT_TAKEN: 'progress.snapshot_taken',
  REPORT_SENT: 'report.sent',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EVENT_VERSIONS = {
  'task.created': 1,
  'task.checked': 1,
  'task.unchecked': 1,
  'task.confirmed': 1,
  'task.returned': 1,
  'task.planned': 1,
  'task.resumed': 1,
  'task.prioritized': 1,
  'task.cancelled': 1,
  'blocker.detected': 1,
  'blocker.declared': 1,
  'blocker.dismissed': 1,
  'review.reminded': 1,
  'canvas.posted': 1,
  'canvas.edited': 1,
  'canvas.full': 1,
  'canvas.carried_over': 1,
  'divergence.detected': 1,
  'user.registered': 1,
  'user.github_login_set': 1,
  'project.created': 1,
  'project.chat_bound': 1,
  'project.repository_connected': 1,
  'project.repository_changed': 1,
  'project.settings_changed': 1,
  'project.member_added': 1,
  'project.member_removed': 1,
  'member.topic_set': 1,
  'chat.reports_topic_set': 1,
  'chat.schedule_set': 1,
  'chat.schedule_cleared': 1,
  'access.denied': 1,
  'github.issue_changed': 1,
  'github.pull_request_changed': 1,
  'github.commits_pushed': 1,
  'github.workflow_completed': 1,
  'github.milestone_changed': 1,
  'github.issue_links_changed': 1,
  'github.reconciled': 1,
  'repo.pr_stalled': 1,
  'progress.snapshot_taken': 1,
  'report.sent': 1,
} as const satisfies Record<EventType, number>;

export interface EventEnvelope {
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
  idempotency_key: string;
  schema_version: number;
}

export interface TaskCreatedPayload {
  task_id: string;
  project_id: string;
  number: number;
  title: string;
  assignee_id: string;
  priority: 'high' | 'normal' | 'low';
}

export interface TaskCheckedPayload {
  task_id: string;
}

export interface TaskUncheckedPayload {
  task_id: string;
}

export interface TaskConfirmedPayload {
  task_id: string;
  confirmed_by: string;
}

export interface TaskReturnedPayload {
  task_id: string;
  returned_by: string;
}

export interface TaskPlannedPayload {
  task_id: string;
}

export interface TaskResumedPayload {
  task_id: string;
}

export interface TaskPrioritizedPayload {
  task_id: string;
  priority: 'high' | 'normal' | 'low';
  previous_priority: 'high' | 'normal' | 'low';
}

export interface TaskCancelledPayload {
  task_id: string;
  cancelled_by: string;
  reason: 'button' | 'member_removed';
}

export interface BlockerDetectedPayload {
  blocker_id: string;
  task_id: string;
  day: number;
}

export interface BlockerDeclaredPayload {
  blocker_id: string;
  reason: string;
}

export interface BlockerDismissedPayload {
  blocker_id: string;
  task_id: string;
}

export interface ReviewRemindedPayload {
  task_id: string;
  lead_ids: string[];
}

export interface CanvasPostedPayload {
  canvas_id: string;
  project_id: string;
  assignee_id: string;
  canvas_date: string;
  message_id: number;
}

export interface CanvasEditedPayload {
  canvas_id: string;
  shrunk: boolean;
}

export interface CanvasFullPayload {
  canvas_id: string;
}

export interface CanvasCarriedOverPayload {
  from_canvas_id: string;
  to_canvas_id: string;
  task_ids: string[];
}

export interface DivergenceDetectedPayload {
  project_id: string;
  date: string;
}

export interface UserRegisteredPayload {
  user_id: string;
  telegram_user_id: number;
  name: string;
  is_root: boolean;
}

export interface UserGithubLoginSetPayload {
  user_id: string;
  github_login: string | null;
}

export interface ProjectCreatedPayload {
  project_id: string;
  name: string;
  description: string;
  timezone: string;
  created_by: string;
}

export interface ProjectChatBoundPayload {
  project_id: string;
  chat_id: string;
}

export interface ProjectRepositoryConnectedPayload {
  project_id: string;
  repository_id: string;
}

export interface ProjectRepositoryChangedPayload {
  project_id: string;
  repository_id: string;
  previous_repository_id: string;
}

export interface ProjectSettingsChangedPayload {
  project_id: string;
  field: 'name' | 'description' | 'timezone' | 'chat' | 'member_role';
  value: string;
}

export interface ProjectMemberAddedPayload {
  project_id: string;
  user_id: string;
  role: 'member' | 'lead';
}

export interface ProjectMemberRemovedPayload {
  project_id: string;
  user_id: string;
  cancelled_task_ids: string[];
}

export interface MemberTopicSetPayload {
  project_id: string;
  user_id: string;
  topic_id: number;
  created: boolean;
}

export interface ChatReportsTopicSetPayload {
  chat_id: string;
  topic_id: number;
  created: boolean;
}

export interface ChatScheduleSetPayload {
  chat_id: string;
  daily_time: string;
  timezone: string;
}

export interface ChatScheduleClearedPayload {
  chat_id: string;
}

export interface AccessDeniedPayload {
  telegram_user_id: number;
  update_kind: string;
}

export interface GithubIssueChangedPayload {
  repository_id: string;
  issue_number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: 'completed' | 'not_planned' | null;
  assignees: string[];
  closed_by_login: string | null;
  updated_at: string;
}

export interface GithubPullRequestChangedPayload {
  repository_id: string;
  pull_request_number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author_login: string;
  updated_at: string;
  merged_at: string | null;
  merged_by_login: string | null;
}

export interface GithubCommitsPushedPayload {
  repository_id: string;
  commits: {
    sha: string;
    author_login: string;
    message: string;
    created_at: string;
  }[];
}

export interface GithubWorkflowCompletedPayload {
  repository_id: string;
  branch: string;
  is_default_branch: boolean;
  conclusion: 'success' | 'failure' | 'cancelled' | 'other';
  pull_request_numbers: number[];
}

export interface GithubMilestoneChangedPayload {
  repository_id: string;
  milestone_number: number;
  title: string;
  state: 'open' | 'closed';
  due_on: string | null;
}

export interface GithubIssueLinksChangedPayload {
  repository_id: string;
  issue_number: number;
  depends_on_issue_number: number;
  link_type: 'blocked_by' | 'sub_issue';
  action: 'added' | 'removed';
}

export interface GithubReconciledPayload {
  repository_id: string;
  restored_facts: number;
}

export interface RepoPrStalledPayload {
  repository_id: string;
  pull_request_number: number;
  author_login: string;
  days: number;
}

export interface ProgressSnapshotTakenPayload {
  project_id: string;
  progress: number | null;
  date: string;
}

export interface ReportSentPayload {
  target: 'private' | 'group';
  chat_id: string;
  topic_id: number | null;
  period_start: string;
  period_end: string;
  trigger: 'schedule' | 'command';
}

export interface PayloadByType {
  'task.created': TaskCreatedPayload;
  'task.checked': TaskCheckedPayload;
  'task.unchecked': TaskUncheckedPayload;
  'task.confirmed': TaskConfirmedPayload;
  'task.returned': TaskReturnedPayload;
  'task.planned': TaskPlannedPayload;
  'task.resumed': TaskResumedPayload;
  'task.prioritized': TaskPrioritizedPayload;
  'task.cancelled': TaskCancelledPayload;
  'blocker.detected': BlockerDetectedPayload;
  'blocker.declared': BlockerDeclaredPayload;
  'blocker.dismissed': BlockerDismissedPayload;
  'review.reminded': ReviewRemindedPayload;
  'canvas.posted': CanvasPostedPayload;
  'canvas.edited': CanvasEditedPayload;
  'canvas.full': CanvasFullPayload;
  'canvas.carried_over': CanvasCarriedOverPayload;
  'divergence.detected': DivergenceDetectedPayload;
  'user.registered': UserRegisteredPayload;
  'user.github_login_set': UserGithubLoginSetPayload;
  'project.created': ProjectCreatedPayload;
  'project.chat_bound': ProjectChatBoundPayload;
  'project.repository_connected': ProjectRepositoryConnectedPayload;
  'project.repository_changed': ProjectRepositoryChangedPayload;
  'project.settings_changed': ProjectSettingsChangedPayload;
  'project.member_added': ProjectMemberAddedPayload;
  'project.member_removed': ProjectMemberRemovedPayload;
  'member.topic_set': MemberTopicSetPayload;
  'chat.reports_topic_set': ChatReportsTopicSetPayload;
  'chat.schedule_set': ChatScheduleSetPayload;
  'chat.schedule_cleared': ChatScheduleClearedPayload;
  'access.denied': AccessDeniedPayload;
  'github.issue_changed': GithubIssueChangedPayload;
  'github.pull_request_changed': GithubPullRequestChangedPayload;
  'github.commits_pushed': GithubCommitsPushedPayload;
  'github.workflow_completed': GithubWorkflowCompletedPayload;
  'github.milestone_changed': GithubMilestoneChangedPayload;
  'github.issue_links_changed': GithubIssueLinksChangedPayload;
  'github.reconciled': GithubReconciledPayload;
  'repo.pr_stalled': RepoPrStalledPayload;
  'progress.snapshot_taken': ProgressSnapshotTakenPayload;
  'report.sent': ReportSentPayload;
}
