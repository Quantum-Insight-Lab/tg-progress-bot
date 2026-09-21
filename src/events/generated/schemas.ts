/**
 * Generated from contracts/event-registry.yaml. Do not edit.
 * Source: npm run codegen:events
 */

import { z } from "zod";
import { EVENT_TYPES } from "./event-types.js";

export const taskCreatedPayloadSchema = z.object({
  task_id: z.string(),
  project_id: z.string(),
  issue_id: z.string(),
  title: z.string(),
  assignee_id: z.string(),
  priority: z.enum(["high", "normal", "low"]),
  target: z.enum(["today", "plan"]),
});

export const taskPrioritizedPayloadSchema = z.object({
  task_id: z.string(),
  priority: z.enum(["high", "normal", "low"]),
  previous_priority: z.enum(["high", "normal", "low"]),
});

export const taskReassignedPayloadSchema = z.object({
  task_id: z.string(),
  assignee_id: z.string(),
  previous_assignee_id: z.string(),
});

export const taskPostponedPayloadSchema = z.object({
  task_id: z.string(),
  from_list_id: z.string().nullable(),
});

export const taskCheckedPayloadSchema = z.object({
  task_id: z.string(),
  list_item_id: z.string(),
});

export const taskUncheckedPayloadSchema = z.object({
  task_id: z.string(),
  list_item_id: z.string(),
});

export const taskConfirmedPayloadSchema = z.object({
  task_id: z.string(),
  confirmed_by: z.string(),
});

export const taskCancelledPayloadSchema = z.object({
  task_id: z.string(),
  cancelled_by: z.string(),
  reason: z.string().nullable(),
});

export const taskCarriedOverPayloadSchema = z.object({
  task_id: z.string(),
  from_list_id: z.string(),
  to_list_id: z.string(),
  day_number: z.number().int(),
});

export const blockerDetectedPayloadSchema = z.object({
  blocker_id: z.string(),
  task_id: z.string(),
  signal_type: z.enum(["no_check", "no_issue_activity", "pr_stale", "ci_red", "no_branch"]),
  detected_at: z.string(),
});

export const blockerDeclaredPayloadSchema = z.object({
  blocker_id: z.string(),
  task_id: z.string(),
  reason: z.string(),
});

export const blockerDismissedPayloadSchema = z.object({
  blocker_id: z.string(),
  task_id: z.string(),
});

export const blockerResolvedPayloadSchema = z.object({
  blocker_id: z.string(),
  task_id: z.string(),
  resolved_by_signal: z.enum(["checked", "activity_resumed", "ci_green", "manual"]),
});

export const projectMemberAddedPayloadSchema = z.object({
  project_id: z.string(),
  user_id: z.string(),
  role: z.enum(["viewer", "member", "lead"]),
  topic_id: z.number().int().nullable(),
});

export const projectMemberRemovedPayloadSchema = z.object({
  project_id: z.string(),
  user_id: z.string(),
});

export const githubIssueUpdatedPayloadSchema = z.object({
  issue_id: z.string(),
  issue_number: z.number().int(),
  state: z.enum(["open", "closed", "not_planned"]),
  title: z.string(),
  milestone_number: z.number().int().nullable(),
  assignee_login: z.string().nullable(),
});

export const githubIssueLinkedPayloadSchema = z.object({
  issue_id: z.string(),
  depends_on_issue_id: z.string(),
  link_type: z.enum(["blocked_by", "sub_issue"]),
  removed: z.boolean(),
});

export const githubPullRequestUpdatedPayloadSchema = z.object({
  pull_request_number: z.number().int(),
  issue_id: z.string().nullable(),
  state: z.enum(["open", "closed", "merged"]),
  updated_at: z.string(),
});

export const githubChecksFailedPayloadSchema = z.object({
  pull_request_number: z.number().int(),
  conclusion: z.enum(["failure", "timed_out", "cancelled"]),
  completed_at: z.string(),
});

export const githubMilestoneUpdatedPayloadSchema = z.object({
  milestone_number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  due_on: z.string().nullable(),
});

export const progressSnapshotTakenPayloadSchema = z.object({
  project_id: z.string(),
  progress: z.number().nullable(),
  tasks_total: z.number().int(),
  tasks_done: z.number().int(),
});

export const reportSentPayloadSchema = z.object({
  report_type: z.enum(["daily", "weekly"]),
  project_ids: z.array(z.string()),
  destination: z.enum(["dm", "group"]),
  chat_id: z.number().int(),
  topic_id: z.number().int().nullable(),
});

export const payloadSchemas = {
  [EVENT_TYPES.TASK_CREATED]: taskCreatedPayloadSchema,
  [EVENT_TYPES.TASK_PRIORITIZED]: taskPrioritizedPayloadSchema,
  [EVENT_TYPES.TASK_REASSIGNED]: taskReassignedPayloadSchema,
  [EVENT_TYPES.TASK_POSTPONED]: taskPostponedPayloadSchema,
  [EVENT_TYPES.TASK_CHECKED]: taskCheckedPayloadSchema,
  [EVENT_TYPES.TASK_UNCHECKED]: taskUncheckedPayloadSchema,
  [EVENT_TYPES.TASK_CONFIRMED]: taskConfirmedPayloadSchema,
  [EVENT_TYPES.TASK_CANCELLED]: taskCancelledPayloadSchema,
  [EVENT_TYPES.TASK_CARRIED_OVER]: taskCarriedOverPayloadSchema,
  [EVENT_TYPES.BLOCKER_DETECTED]: blockerDetectedPayloadSchema,
  [EVENT_TYPES.BLOCKER_DECLARED]: blockerDeclaredPayloadSchema,
  [EVENT_TYPES.BLOCKER_DISMISSED]: blockerDismissedPayloadSchema,
  [EVENT_TYPES.BLOCKER_RESOLVED]: blockerResolvedPayloadSchema,
  [EVENT_TYPES.PROJECT_MEMBER_ADDED]: projectMemberAddedPayloadSchema,
  [EVENT_TYPES.PROJECT_MEMBER_REMOVED]: projectMemberRemovedPayloadSchema,
  [EVENT_TYPES.GITHUB_ISSUE_UPDATED]: githubIssueUpdatedPayloadSchema,
  [EVENT_TYPES.GITHUB_ISSUE_LINKED]: githubIssueLinkedPayloadSchema,
  [EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED]: githubPullRequestUpdatedPayloadSchema,
  [EVENT_TYPES.GITHUB_CHECKS_FAILED]: githubChecksFailedPayloadSchema,
  [EVENT_TYPES.GITHUB_MILESTONE_UPDATED]: githubMilestoneUpdatedPayloadSchema,
  [EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN]: progressSnapshotTakenPayloadSchema,
  [EVENT_TYPES.REPORT_SENT]: reportSentPayloadSchema,
} as const;
