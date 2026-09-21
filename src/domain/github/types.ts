import { EVENT_TYPES } from "../../events/generated/event-types.js";
import type { PayloadByType } from "../../events/generated/payloads.js";

export const GITHUB_ACTOR = { id: "github", role: "external" } as const;

export type GithubIssueUpdatedEvent = {
  type: typeof EVENT_TYPES.GITHUB_ISSUE_UPDATED;
  actor: typeof GITHUB_ACTOR;
  subject: { entity: "Issue"; id: string };
  payload: PayloadByType["github.issue_updated"];
  idempotencyKey: string;
};

export type GithubIssueLinkedEvent = {
  type: typeof EVENT_TYPES.GITHUB_ISSUE_LINKED;
  actor: typeof GITHUB_ACTOR;
  subject: { entity: "Issue"; id: string };
  payload: PayloadByType["github.issue_linked"];
  idempotencyKey: string;
};

export type GithubPullRequestUpdatedEvent = {
  type: typeof EVENT_TYPES.GITHUB_PULL_REQUEST_UPDATED;
  actor: typeof GITHUB_ACTOR;
  subject: { entity: "PullRequest"; id: string };
  payload: PayloadByType["github.pull_request_updated"];
  idempotencyKey: string;
};

export type GithubChecksFailedEvent = {
  type: typeof EVENT_TYPES.GITHUB_CHECKS_FAILED;
  actor: typeof GITHUB_ACTOR;
  subject: { entity: "CheckRun"; id: string };
  payload: PayloadByType["github.checks_failed"];
  idempotencyKey: string;
};

export type GithubMilestoneUpdatedEvent = {
  type: typeof EVENT_TYPES.GITHUB_MILESTONE_UPDATED;
  actor: typeof GITHUB_ACTOR;
  subject: { entity: "Stage"; id: string };
  payload: PayloadByType["github.milestone_updated"];
  idempotencyKey: string;
};

export type GithubFactEvent =
  | GithubIssueUpdatedEvent
  | GithubIssueLinkedEvent
  | GithubPullRequestUpdatedEvent
  | GithubChecksFailedEvent
  | GithubMilestoneUpdatedEvent;
