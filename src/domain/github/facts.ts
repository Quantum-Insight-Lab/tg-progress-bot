import { EVENT_TYPES } from "../../events/generated/event-types.js";
import { GITHUB_ACTOR } from "./types.js";
import type {
  GithubChecksFailedEvent,
  GithubIssueLinkedEvent,
  GithubIssueUpdatedEvent,
  GithubMilestoneUpdatedEvent,
  GithubPullRequestUpdatedEvent,
} from "./types.js";

export function recordIssueUpdated(input: {
  issueId: string;
  deliveryId: string;
  issueNumber: number;
  state: "open" | "closed" | "not_planned";
  title: string;
  milestoneNumber: number | null;
  assigneeLogin: string | null;
}): GithubIssueUpdatedEvent {
  return {
    type: EVENT_TYPES.GITHUB_ISSUE_UPDATED,
    actor: GITHUB_ACTOR,
    subject: { entity: "Issue", id: input.issueId },
    payload: {
      issue_id: input.issueId,
      issue_number: input.issueNumber,
      state: input.state,
      title: input.title,
      milestone_number: input.milestoneNumber,
      assignee_login: input.assigneeLogin,
    },
    idempotencyKey: input.deliveryId,
  };
}

export function recordIssueLinked(input: {
  issueId: string;
  dependsOnIssueId: string;
  deliveryId: string;
  linkType: "blocked_by" | "sub_issue";
  removed: boolean;
}): GithubIssueLinkedEvent {
  return {
    type: EVENT_TYPES.GITHUB_ISSUE_LINKED,
    actor: GITHUB_ACTOR,
    subject: { entity: "Issue", id: input.issueId },
    payload: {
      issue_id: input.issueId,
      depends_on_issue_id: input.dependsOnIssueId,
      link_type: input.linkType,
      removed: input.removed,
    },
    idempotencyKey: input.deliveryId,
  };
}

export function recordPullRequestUpdated(input: {
  pullRequestId: string;
  deliveryId: string;
  pullRequestNumber: number;
  issueId: string | null;
  state: "open" | "closed" | "merged";
  updatedAt: string;
}): GithubPullRequestUpdatedEvent {
  return {
    type: EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED,
    actor: GITHUB_ACTOR,
    subject: { entity: "PullRequest", id: input.pullRequestId },
    payload: {
      pull_request_number: input.pullRequestNumber,
      issue_id: input.issueId,
      state: input.state,
      updated_at: input.updatedAt,
    },
    idempotencyKey: input.deliveryId,
  };
}

export function recordChecksFailed(input: {
  checkRunId: string;
  deliveryId: string;
  pullRequestNumber: number;
  conclusion: "failure" | "timed_out" | "cancelled";
  completedAt: string;
}): GithubChecksFailedEvent {
  return {
    type: EVENT_TYPES.GITHUB_CHECKS_FAILED,
    actor: GITHUB_ACTOR,
    subject: { entity: "CheckRun", id: input.checkRunId },
    payload: {
      pull_request_number: input.pullRequestNumber,
      conclusion: input.conclusion,
      completed_at: input.completedAt,
    },
    idempotencyKey: input.deliveryId,
  };
}

export function recordMilestoneUpdated(input: {
  stageId: string;
  deliveryId: string;
  milestoneNumber: number;
  title: string;
  state: "open" | "closed";
  dueOn: string | null;
}): GithubMilestoneUpdatedEvent {
  return {
    type: EVENT_TYPES.GITHUB_MILESTONE_UPDATED,
    actor: GITHUB_ACTOR,
    subject: { entity: "Stage", id: input.stageId },
    payload: {
      milestone_number: input.milestoneNumber,
      title: input.title,
      state: input.state,
      due_on: input.dueOn,
    },
    idempotencyKey: input.deliveryId,
  };
}
