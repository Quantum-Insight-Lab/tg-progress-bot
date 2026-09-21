import { constants } from "../../config/index.js";
import { detectBlocker, type BlockerDetectedEvent } from "./blockers.js";
import type { Blocker, BlockerSignal, Task } from "./types.js";

export type GithubIdleFacts = {
  ciRed: boolean;
  prIdleDays: number;
  issueIdleDays: number;
  noBranchDays: number;
};

export function isStale(daysWithoutMotion: number): boolean {
  return daysWithoutMotion > constants.staleDays;
}

export function mayReAsk(daysSinceLastAsk: number | null): boolean {
  if (daysSinceLastAsk === null) {
    return true;
  }
  return daysSinceLastAsk >= constants.reAskDays;
}

export function signalsDue(input: {
  daysWithoutCheck: number;
  githubAvailable: boolean;
  github: GithubIdleFacts | null;
}): BlockerSignal[] {
  const due: BlockerSignal[] = [];
  if (isStale(input.daysWithoutCheck)) {
    due.push("no_check");
  }
  if (!input.githubAvailable || input.github === null) {
    return due;
  }
  if (input.github.ciRed && isStale(input.github.prIdleDays)) {
    due.push("ci_red");
  }
  if (isStale(input.github.prIdleDays)) {
    due.push("pr_stale");
  }
  if (isStale(input.github.issueIdleDays)) {
    due.push("no_issue_activity");
  }
  if (isStale(input.github.noBranchDays)) {
    due.push("no_branch");
  }
  return due;
}

function hasActiveSignal(
  blockers: readonly Blocker[],
  taskId: string,
  signal: BlockerSignal,
): boolean {
  return blockers.some(
    (blocker) =>
      blocker.active && blocker.taskId === taskId && blocker.signalType === signal,
  );
}

export function applyStaleSignals(input: {
  task: Task;
  blockers: readonly Blocker[];
  signals: readonly BlockerSignal[];
  blockerIdFor: (signal: BlockerSignal) => string;
  detectedAt: string;
  detectedOnDate: string;
}): {
  task: Task;
  blockers: Blocker[];
  events: BlockerDetectedEvent[];
} {
  let task = input.task;
  let blockers = [...input.blockers];
  const events: BlockerDetectedEvent[] = [];
  for (const signal of input.signals) {
    if (hasActiveSignal(blockers, task.id, signal)) {
      continue;
    }
    const detected = detectBlocker({
      task,
      blockers,
      blockerId: input.blockerIdFor(signal),
      signalType: signal,
      detectedAt: input.detectedAt,
      detectedOnDate: input.detectedOnDate,
    });
    task = detected.task;
    blockers = detected.blockers;
    events.push(detected.event);
  }
  return { task, blockers, events };
}
