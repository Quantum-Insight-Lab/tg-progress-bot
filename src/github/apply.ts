import { randomUUID } from "node:crypto";
import {
  recordChecksFailed,
  recordIssueLinked,
  recordIssueUpdated,
  recordMilestoneUpdated,
  recordPullRequestUpdated,
} from "../domain/github/index.js";
import { emit } from "../events/emit.js";
import { getDb } from "../infrastructure/db.js";
import {
  idOfIssue,
  idOfPullRequest,
  idOfStage,
  persistGithubFact,
} from "./mirror.js";
import type { ParsedGithubFact } from "./parse.js";

async function linkedIssueId(
  projectId: string,
  issueNumber: number,
): Promise<string | null> {
  const row = await getDb()
    .selectFrom("issues")
    .select("id")
    .where("project_id", "=", projectId)
    .where("issue_number", "=", issueNumber)
    .executeTakeFirst();
  return row?.id ?? null;
}

export function reconcileFactKey(
  projectId: string,
  fact: ParsedGithubFact,
): string {
  if (fact.kind === "issue_updated") {
    return [
      "reconcile",
      projectId,
      "issue",
      String(fact.issueNumber),
      fact.state,
      fact.title,
      fact.assigneeLogin ?? "",
      String(fact.milestoneNumber ?? ""),
    ].join(":");
  }
  if (fact.kind === "issue_linked") {
    return [
      "reconcile",
      projectId,
      "link",
      String(fact.issueNumber),
      String(fact.dependsOnIssueNumber),
      fact.linkType,
      fact.removed ? "removed" : "added",
    ].join(":");
  }
  if (fact.kind === "pull_request_updated") {
    return [
      "reconcile",
      projectId,
      "pr",
      String(fact.pullRequestNumber),
      fact.state,
      fact.updatedAt,
    ].join(":");
  }
  if (fact.kind === "checks_failed") {
    return [
      "reconcile",
      projectId,
      "check",
      String(fact.pullRequestNumber),
      fact.conclusion,
      fact.completedAt,
    ].join(":");
  }
  return [
    "reconcile",
    projectId,
    "milestone",
    String(fact.milestoneNumber),
    fact.state,
    fact.title,
    fact.dueOn ?? "",
  ].join(":");
}

export async function applyGithubFact(
  projectId: string,
  idempotencyKey: string,
  fact: ParsedGithubFact,
): Promise<boolean> {
  if (fact.kind === "issue_updated") {
    const issueId = await idOfIssue(projectId, fact.issueNumber);
    const stageId =
      fact.milestone === null
        ? undefined
        : await idOfStage(projectId, fact.milestone.number);
    const event = recordIssueUpdated({
      issueId,
      deliveryId: idempotencyKey,
      issueNumber: fact.issueNumber,
      state: fact.state,
      title: fact.title,
      milestoneNumber: fact.milestoneNumber,
      assigneeLogin: fact.assigneeLogin,
    });
    const result = await emit(event.type, {
      actor: event.actor,
      subject: event.subject,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (!result.applied) {
      return false;
    }
    await persistGithubFact(projectId, fact, { issueId, stageId });
    return true;
  }

  if (fact.kind === "issue_linked") {
    const issueId = await idOfIssue(projectId, fact.issueNumber);
    const dependsOnIssueId = await idOfIssue(
      projectId,
      fact.dependsOnIssueNumber,
    );
    const event = recordIssueLinked({
      issueId,
      dependsOnIssueId,
      deliveryId: idempotencyKey,
      linkType: fact.linkType,
      removed: fact.removed,
    });
    const result = await emit(event.type, {
      actor: event.actor,
      subject: event.subject,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (!result.applied) {
      return false;
    }
    await persistGithubFact(projectId, fact, { issueId, dependsOnIssueId });
    return true;
  }

  if (fact.kind === "pull_request_updated") {
    const pullRequestId = await idOfPullRequest(
      projectId,
      fact.pullRequestNumber,
    );
    const issueId = await linkedIssueId(projectId, fact.pullRequestNumber);
    const event = recordPullRequestUpdated({
      pullRequestId,
      deliveryId: idempotencyKey,
      pullRequestNumber: fact.pullRequestNumber,
      issueId,
      state: fact.state,
      updatedAt: fact.updatedAt,
    });
    const result = await emit(event.type, {
      actor: event.actor,
      subject: event.subject,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (!result.applied) {
      return false;
    }
    await persistGithubFact(projectId, fact, {
      pullRequestId,
      issueId: issueId ?? undefined,
    });
    return true;
  }

  if (fact.kind === "checks_failed") {
    const pullRequestId = await idOfPullRequest(
      projectId,
      fact.pullRequestNumber,
    );
    const checkRunId = randomUUID();
    const event = recordChecksFailed({
      checkRunId,
      deliveryId: idempotencyKey,
      pullRequestNumber: fact.pullRequestNumber,
      conclusion: fact.conclusion,
      completedAt: fact.completedAt,
    });
    const result = await emit(event.type, {
      actor: event.actor,
      subject: event.subject,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (!result.applied) {
      return false;
    }
    await persistGithubFact(projectId, fact, { pullRequestId, checkRunId });
    return true;
  }

  const stageId = await idOfStage(projectId, fact.milestoneNumber);
  const event = recordMilestoneUpdated({
    stageId,
    deliveryId: idempotencyKey,
    milestoneNumber: fact.milestoneNumber,
    title: fact.title,
    state: fact.state,
    dueOn: fact.dueOn,
  });
  const result = await emit(event.type, {
    actor: event.actor,
    subject: event.subject,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
  });
  if (!result.applied) {
    return false;
  }
  await persistGithubFact(projectId, fact, { stageId });
  return true;
}
