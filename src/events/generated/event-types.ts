/**
 * Generated from contracts/event-registry.yaml. Do not edit.
 * Source: npm run codegen:events
 */

export const EVENT_TYPES = {
  TASK_CREATED: "task.created",
  TASK_PRIORITIZED: "task.prioritized",
  TASK_REASSIGNED: "task.reassigned",
  TASK_POSTPONED: "task.postponed",
  TASK_CHECKED: "task.checked",
  TASK_UNCHECKED: "task.unchecked",
  TASK_CONFIRMED: "task.confirmed",
  TASK_CANCELLED: "task.cancelled",
  TASK_CARRIED_OVER: "task.carried_over",
  BLOCKER_DETECTED: "blocker.detected",
  BLOCKER_DECLARED: "blocker.declared",
  BLOCKER_DISMISSED: "blocker.dismissed",
  BLOCKER_RESOLVED: "blocker.resolved",
  PROJECT_MEMBER_ADDED: "project.member_added",
  PROJECT_MEMBER_REMOVED: "project.member_removed",
  GITHUB_ISSUE_UPDATED: "github.issue_updated",
  GITHUB_ISSUE_LINKED: "github.issue_linked",
  GITHUB_PULL_REQUEST_UPDATED: "github.pull_request_updated",
  GITHUB_CHECKS_FAILED: "github.checks_failed",
  GITHUB_MILESTONE_UPDATED: "github.milestone_updated",
  PROGRESS_SNAPSHOT_TAKEN: "progress.snapshot_taken",
  REPORT_SENT: "report.sent",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EVENT_TYPE_VALUES: readonly EventType[] = Object.values(EVENT_TYPES);
