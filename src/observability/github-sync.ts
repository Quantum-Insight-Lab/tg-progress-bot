type GithubSyncState = {
  lastTouchEpochMs: number | null;
  lastReconcileEpochMs: number | null;
};

let state: GithubSyncState = {
  lastTouchEpochMs: null,
  lastReconcileEpochMs: null,
};

export function markGithubTouched(atEpochMs: number): void {
  state = { ...state, lastTouchEpochMs: atEpochMs };
}

export function markGithubReconciled(atEpochMs: number): void {
  state = {
    lastTouchEpochMs: atEpochMs,
    lastReconcileEpochMs: atEpochMs,
  };
}

export function lastGithubReconcileEpochMs(): number | null {
  return state.lastReconcileEpochMs;
}

/** Возраст самых свежих данных из GitHub (docs/pda/08). */
export function githubSyncLag(nowEpochMs: number): number | null {
  if (state.lastTouchEpochMs === null) {
    return null;
  }
  return nowEpochMs - state.lastTouchEpochMs;
}

export function resetGithubSyncForTests(): void {
  state = { lastTouchEpochMs: null, lastReconcileEpochMs: null };
}
