import { constants } from "../config/index.js";
import { isReconcileDue } from "../domain/github/index.js";
import { clock, type Clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import { logger } from "../infrastructure/logger.js";
import {
  lastGithubReconcileEpochMs,
  markGithubReconciled,
} from "../observability/github-sync.js";
import { applyGithubFact, reconcileFactKey } from "./apply.js";
import { githubClient } from "./client.js";
import { mirrorMatches } from "./mirror.js";
import { octokitGithubReader, type GithubReader } from "./reader.js";

export function githubReconcileIntervalMs(): number {
  return constants.githubReconcileIntervalMinutes * 60 * 1000;
}

export type ReconcileGithubMirrorResult = {
  ran: boolean;
  applied: number;
  readerCalls: number;
};

export async function reconcileGithubMirror(deps?: {
  clock?: Clock;
  reader?: GithubReader;
  nowEpochMs?: number;
  lastRunEpochMs?: number | null;
  intervalMs?: number;
}): Promise<ReconcileGithubMirrorResult> {
  const usedClock = deps?.clock ?? clock;
  const nowEpochMs = deps?.nowEpochMs ?? usedClock.now("UTC").epochMs;
  const intervalMs = deps?.intervalMs ?? githubReconcileIntervalMs();
  const lastRunEpochMs =
    deps?.lastRunEpochMs === undefined
      ? lastGithubReconcileEpochMs()
      : deps.lastRunEpochMs;
  if (
    !isReconcileDue({
      lastRunEpochMs,
      nowEpochMs,
      intervalMs,
    })
  ) {
    return { ran: false, applied: 0, readerCalls: 0 };
  }

  const reader = deps?.reader ?? octokitGithubReader(githubClient());
  const projects = await getDb()
    .selectFrom("projects")
    .select(["id", "repository"])
    .execute();
  const byRepo = new Map<string, string[]>();
  for (const project of projects) {
    const list = byRepo.get(project.repository) ?? [];
    list.push(project.id);
    byRepo.set(project.repository, list);
  }

  let applied = 0;
  let readerCalls = 0;
  for (const [repository, projectIds] of byRepo) {
    readerCalls += 1;
    const facts = (await reader.factsFor(repository)).filter(
      (fact) => fact.repository === repository,
    );
    for (const projectId of projectIds) {
      for (const fact of facts) {
        if (await mirrorMatches(projectId, fact)) {
          continue;
        }
        const published = await applyGithubFact(
          projectId,
          reconcileFactKey(projectId, fact),
          fact,
        );
        if (published) {
          applied += 1;
        }
      }
    }
  }

  markGithubReconciled(nowEpochMs);
  return { ran: true, applied, readerCalls };
}

export function startGithubReconcileLoop(deps?: {
  intervalMs?: number;
  run?: () => Promise<unknown>;
}): () => void {
  const intervalMs = deps?.intervalMs ?? githubReconcileIntervalMs();
  const run = deps?.run ?? (() => reconcileGithubMirror());

  const tick = (): void => {
    void run().catch((error: unknown) => {
      logger.error("github reconcile failed", { error: String(error) });
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
