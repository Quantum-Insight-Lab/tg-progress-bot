/** Сверка GitHub: интервал и лаг без Date в домене (S-10). */

export function isReconcileDue(input: {
  lastRunEpochMs: number | null;
  nowEpochMs: number;
  intervalMs: number;
}): boolean {
  if (input.lastRunEpochMs === null) {
    return true;
  }
  return input.nowEpochMs - input.lastRunEpochMs >= input.intervalMs;
}

export function githubSyncLagMs(input: {
  lastTouchEpochMs: number | null;
  nowEpochMs: number;
}): number | null {
  if (input.lastTouchEpochMs === null) {
    return null;
  }
  return input.nowEpochMs - input.lastTouchEpochMs;
}
