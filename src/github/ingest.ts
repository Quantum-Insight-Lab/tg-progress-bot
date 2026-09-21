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
import { logger } from "../infrastructure/logger.js";
import {
  idOfIssue,
  idOfPullRequest,
  idOfStage,
  persistGithubFact,
} from "./mirror.js";
import { parseGithubFact, type ParsedGithubFact } from "./parse.js";
import { verifyGithubSignature } from "./signature.js";

export type IngestGithubWebhookInput = {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  deliveryId: string | undefined;
  eventName: string | undefined;
};

export type IngestGithubWebhookResult =
  | { ok: true; applied: boolean }
  | {
      ok: false;
      reason:
        | "invalid_signature"
        | "missing_delivery"
        | "invalid_json"
        | "unknown_repository"
        | "ignored_event";
    };

function deliveryKey(deliveryId: string, projectId: string): string {
  return `${deliveryId}:${projectId}`;
}

export async function ingestGithubWebhook(
  input: IngestGithubWebhookInput,
): Promise<IngestGithubWebhookResult> {
  if (!verifyGithubSignature(input)) {
    logger.warn("github webhook: invalid signature");
    return { ok: false, reason: "invalid_signature" };
  }
  if (input.deliveryId === undefined || input.deliveryId.length === 0) {
    return { ok: false, reason: "missing_delivery" };
  }
  if (input.eventName === undefined) {
    return { ok: false, reason: "ignored_event" };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const fact = parseGithubFact(input.eventName, body);
  if (fact === undefined) {
    return { ok: false, reason: "ignored_event" };
  }

  const projects = await getDb()
    .selectFrom("projects")
    .select("id")
    .where("repository", "=", fact.repository)
    .execute();
  if (projects.length === 0) {
    return { ok: false, reason: "unknown_repository" };
  }

  let applied = false;
  for (const project of projects) {
    const published = await publishFact(
      project.id,
      deliveryKey(input.deliveryId, project.id),
      fact,
    );
    if (published) {
      applied = true;
    }
  }
  return { ok: true, applied };
}

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

async function publishFact(
  projectId: string,
  deliveryId: string,
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
      deliveryId,
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
      deliveryId,
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
      deliveryId,
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
      deliveryId,
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
    deliveryId,
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
