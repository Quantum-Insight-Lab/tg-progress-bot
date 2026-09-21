import { applyGithubFact } from "./apply.js";
import { getDb } from "../infrastructure/db.js";
import { clock } from "../infrastructure/clock.js";
import { logger } from "../infrastructure/logger.js";
import { markGithubTouched } from "../observability/github-sync.js";
import { parseGithubFact } from "./parse.js";
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
    const published = await applyGithubFact(
      project.id,
      deliveryKey(input.deliveryId, project.id),
      fact,
    );
    if (published) {
      applied = true;
    }
  }
  markGithubTouched(clock.now("UTC").epochMs);
  return { ok: true, applied };
}
