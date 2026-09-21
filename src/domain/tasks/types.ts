import type { Priority } from "../../config/index.js";

export const TASK_STATUSES = [
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type ActorRole = "viewer" | "member" | "lead";

export type IssueRef = {
  id: string;
  projectId: string;
};

export type MemberRef = {
  projectId: string;
  userId: string;
};

export type ProjectActor = {
  userId: string;
  role: ActorRole;
  projectId: string;
};

export const BLOCKER_SIGNALS = [
  "no_check",
  "no_issue_activity",
  "pr_stale",
  "ci_red",
  "no_branch",
] as const;

export type BlockerSignal = (typeof BLOCKER_SIGNALS)[number];

export type Blocker = {
  id: string;
  taskId: string;
  source: string;
  signalType: BlockerSignal | null;
  reason: string | null;
  active: boolean;
};

export type Task = {
  id: string;
  projectId: string;
  issueId: string;
  assigneeId: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  createdByUserId: string;
};

export type TaskListItem = {
  id: string;
  projectId: string;
  listId: string;
  taskId: string;
  position: number;
  isDone: boolean;
  carriedFromListId: string | null;
};

export type TaskList = {
  id: string;
  projectId: string;
  listDate: string;
  topicId: number | null;
  messageId: number | null;
  items: TaskListItem[];
};
