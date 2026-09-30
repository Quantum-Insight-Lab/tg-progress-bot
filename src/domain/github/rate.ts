import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';

export const RATE_SUBJECT = 'App';

export const RATE_SUBJECT_ID = 'app';

/** Ключ `github.rate_observed`: один остаток на ход сверки. */
export function githubRateKey(runStartedAt: Date): string {
  return `${EVENT_TYPES.GITHUB_RATE_OBSERVED}+${runStartedAt.toISOString()}`;
}

/**
 * A-41. Остаток лимита App, не строка зеркала.
 * Повтор того же хода второй факт не пишет. В GitHub эта функция не ходит.
 */
export async function publishGithubRate(
  journal: EventJournal,
  input: { remainingPercent: number; runStartedAt: Date },
): Promise<boolean> {
  const published = await emit(journal, {
    type: EVENT_TYPES.GITHUB_RATE_OBSERVED,
    source: 'system',
    idempotencyKey: githubRateKey(input.runStartedAt),
    payload: { remaining_percent: input.remainingPercent },
    actor: { id: 'system', role: 'system' },
    subject: { entity: RATE_SUBJECT, id: RATE_SUBJECT_ID },
    occurredAt: input.runStartedAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}
