import type { Bot } from "grammy";
import { githubReconcileIntervalMs } from "../config/index.js";
import { githubSignalsAllowed } from "../domain/github/index.js";
import type { GithubIdleFacts } from "../domain/tasks/index.js";
import { clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import { logger } from "../infrastructure/logger.js";
import { githubSyncLag } from "../observability/github-sync.js";
import { scanStaleTasks, type DayListStore } from "../telegram/index.js";

const FAILING_CONCLUSIONS = ["failure", "timed_out", "cancelled"] as const;

/** Свежие данные GitHub — факты CI попадают в опрос. Иначе опрос их не видит (C-6). */
export function githubFactsForStaleScan(
  lagMs: number | null,
  intervalMs: number,
  facts: ReadonlyMap<string, GithubIdleFacts>,
): ReadonlyMap<string, GithubIdleFacts> | undefined {
  if (!githubSignalsAllowed(lagMs, intervalMs)) {
    return undefined;
  }
  return facts;
}

export async function loadStaleGithubFacts(
  projectId: string,
  timeZone: string,
): Promise<Map<string, GithubIdleFacts>> {
  const today = clock.calendarDate(timeZone);
  const rows = await getDb()
    .selectFrom("tasks")
    .innerJoin("issue_pull_requests", "issue_pull_requests.issue_id", "tasks.issue_id")
    .innerJoin("check_runs", "check_runs.pull_request_id", "issue_pull_requests.id")
    .select([
      "tasks.id as task_id",
      "check_runs.completed_at as completed_at",
    ])
    .where("tasks.project_id", "=", projectId)
    .where("issue_pull_requests.state", "=", "open")
    .where("check_runs.conclusion", "in", [...FAILING_CONCLUSIONS])
    .execute();
  const facts = new Map<string, GithubIdleFacts>();
  for (const row of rows) {
    const idle =
      row.completed_at === null
        ? 0
        : clock.daysBetween(clock.calendarDateAt(row.completed_at, timeZone), today);
    const previous = facts.get(row.task_id);
    facts.set(row.task_id, {
      ciRed: true,
      prIdleDays: Math.max(previous?.prIdleDays ?? 0, idle),
      issueIdleDays: 0,
      noBranchDays: 0,
    });
  }
  return facts;
}

export async function runStaleScan(deps: {
  bot: Bot;
  store: DayListStore;
  lagMs: number | null;
  projectIds: readonly string[];
  factsFor?: (projectId: string) => Promise<ReadonlyMap<string, GithubIdleFacts>>;
}): Promise<void> {
  const intervalMs = githubReconcileIntervalMs();
  for (const projectId of deps.projectIds) {
    const timeZone = deps.store.timeZoneOf(projectId);
    const loaded =
      deps.factsFor !== undefined
        ? await deps.factsFor(projectId)
        : timeZone === undefined
          ? new Map<string, GithubIdleFacts>()
          : await loadStaleGithubFacts(projectId, timeZone);
    const facts = githubFactsForStaleScan(deps.lagMs, intervalMs, loaded);
    await scanStaleTasks(deps.bot, deps.store, {
      projectId,
      githubLagMs: deps.lagMs,
      ...(facts === undefined ? {} : { githubFactsByTaskId: facts }),
    });
  }
}

export function startStaleScanLoop(deps: {
  bot: Bot;
  store: DayListStore;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? githubReconcileIntervalMs();
  const tick = (): void => {
    const lagMs = githubSyncLag(clock.now("UTC").epochMs);
    void getDb()
      .selectFrom("projects")
      .select("id")
      .execute()
      .then((rows) =>
        runStaleScan({
          bot: deps.bot,
          store: deps.store,
          lagMs,
          projectIds: rows.map((row) => row.id),
        }),
      )
      .catch((error: unknown) => {
        logger.error("stale scan failed", { error: String(error) });
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
