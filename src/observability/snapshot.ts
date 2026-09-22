import { clock } from "../infrastructure/clock.js";
import {
  duplicateDeliveries,
  githubRateRemaining,
  invariantViolations,
  rejectedCommands,
  reportDeliveryFailures,
  schedulerMissedRuns,
  telegramApiErrors,
} from "./counters.js";
import { coverageGapOverall } from "./coverage.js";
import { githubSyncLag } from "./github-sync.js";
import {
  blockerAnswerRates,
  blockerClarityHours,
  confirmationHours,
  orphanSignals,
} from "./rates.js";

export type StabilitySnapshot = {
  time_to_clarity_blocker: number | null;
  time_to_confirmation: number | null;
  answer_rate: number | null;
  dismiss_rate: number | null;
  coverage_gap: number | null;
  duplicate_deliveries: number;
  github_sync_lag: number | null;
  orphan_signals: number;
  invariant_violations: number;
  rejected_commands: ReturnType<typeof rejectedCommands>;
  telegram_api_errors: Record<string, number>;
  github_rate_remaining: number | null;
  scheduler_missed_runs: number;
  report_delivery_failures: { dm: number; group: number };
};

export async function stabilitySnapshot(): Promise<StabilitySnapshot> {
  const rates = await blockerAnswerRates();
  return {
    time_to_clarity_blocker: await blockerClarityHours(),
    time_to_confirmation: await confirmationHours(),
    answer_rate: rates.answerRate,
    dismiss_rate: rates.dismissRate,
    coverage_gap: await coverageGapOverall(),
    duplicate_deliveries: duplicateDeliveries(),
    github_sync_lag: githubSyncLag(clock.now("UTC").epochMs),
    orphan_signals: await orphanSignals(),
    invariant_violations: invariantViolations(),
    rejected_commands: rejectedCommands(),
    telegram_api_errors: telegramApiErrors(),
    github_rate_remaining: githubRateRemaining(),
    scheduler_missed_runs: schedulerMissedRuns(),
    report_delivery_failures: reportDeliveryFailures(),
  };
}
