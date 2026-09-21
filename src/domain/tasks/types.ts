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
