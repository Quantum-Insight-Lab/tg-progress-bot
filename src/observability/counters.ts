import type { DomainErrorCode } from "../domain/shared/errors.js";

type Counters = {
  rejectedCommands: Record<DomainErrorCode, number>;
  duplicateDeliveries: number;
  invariantViolations: number;
  reportDeliveryFailures: { dm: number; group: number };
  schedulerMissedRuns: number;
  telegramApiErrors: Record<string, number>;
  githubRateRemaining: number | null;
  firedAlertKeys: Set<string>;
  missedPeriodKeys: Set<string>;
};

function emptyRejected(): Record<DomainErrorCode, number> {
  return {
    role_denied: 0,
    not_a_member: 0,
    invalid_transition: 0,
    list_full: 0,
  };
}

function empty(): Counters {
  return {
    rejectedCommands: emptyRejected(),
    duplicateDeliveries: 0,
    invariantViolations: 0,
    reportDeliveryFailures: { dm: 0, group: 0 },
    schedulerMissedRuns: 0,
    telegramApiErrors: {},
    githubRateRemaining: null,
    firedAlertKeys: new Set(),
    missedPeriodKeys: new Set(),
  };
}

let state: Counters = empty();

export function resetObservabilityCountersForTests(): void {
  state = empty();
}

export function recordRejectedCommand(code: DomainErrorCode): void {
  state.rejectedCommands[code] += 1;
}

export function rejectedCommands(): Record<DomainErrorCode, number> {
  return { ...state.rejectedCommands };
}

export function recordDuplicateDelivery(): void {
  state.duplicateDeliveries += 1;
}

export function duplicateDeliveries(): number {
  return state.duplicateDeliveries;
}

export function recordInvariantViolation(): void {
  state.invariantViolations += 1;
}

export function invariantViolations(): number {
  return state.invariantViolations;
}

export function recordReportDeliveryFailure(destination: "dm" | "group"): void {
  state.reportDeliveryFailures[destination] += 1;
}

export function reportDeliveryFailures(): { dm: number; group: number } {
  return { ...state.reportDeliveryFailures };
}

export function recordSchedulerMissedRun(periodKey: string): boolean {
  if (state.missedPeriodKeys.has(periodKey)) {
    return false;
  }
  state.missedPeriodKeys.add(periodKey);
  state.schedulerMissedRuns += 1;
  return true;
}

export function schedulerMissedRuns(): number {
  return state.schedulerMissedRuns;
}

export function recordTelegramApiError(code: string): void {
  const current = state.telegramApiErrors[code] ?? 0;
  state.telegramApiErrors[code] = current + 1;
}

export function telegramApiErrors(): Record<string, number> {
  return { ...state.telegramApiErrors };
}

export function markGithubRateRemaining(remaining: number): void {
  state.githubRateRemaining = remaining;
}

export function githubRateRemaining(): number | null {
  return state.githubRateRemaining;
}

export type ImmediateAlertKind =
  | "invariant_violations"
  | "report_delivery_failures"
  | "scheduler_missed_runs";

export type ImmediateAlert = {
  kind: ImmediateAlertKind;
  text: string;
};

function claim(kind: ImmediateAlertKind, key: string, text: string): ImmediateAlert | null {
  if (state.firedAlertKeys.has(key)) {
    return null;
  }
  state.firedAlertKeys.add(key);
  return { kind, text };
}

/** Ночные алерты по coverage_gap запрещены (#22). */
export function coverageGapAlertsAtNight(): boolean {
  return false;
}

export function takeDueImmediateAlerts(): ImmediateAlert[] {
  const alerts: ImmediateAlert[] = [];
  if (state.invariantViolations > 0) {
    const alert = claim(
      "invariant_violations",
      "invariant_violations",
      "invariant_violations > 0",
    );
    if (alert !== null) {
      alerts.push(alert);
    }
  }
  const delivery =
    state.reportDeliveryFailures.dm + state.reportDeliveryFailures.group;
  if (delivery > 0) {
    const alert = claim(
      "report_delivery_failures",
      `report_delivery_failures:${String(delivery)}`,
      "report_delivery_failures > 0",
    );
    if (alert !== null) {
      alerts.push(alert);
    }
  }
  if (state.schedulerMissedRuns > 0) {
    const alert = claim(
      "scheduler_missed_runs",
      `scheduler_missed_runs:${String(state.schedulerMissedRuns)}`,
      "scheduler_missed_runs > 0",
    );
    if (alert !== null) {
      alerts.push(alert);
    }
  }
  return alerts;
}
