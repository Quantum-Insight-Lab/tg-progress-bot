import type { Kysely } from 'kysely';
import { publishGithubRate } from '../domain/github/rate.ts';
import type { Logger } from '../domain/shared/logger.ts';
import { rateBelowFloor } from '../domain/shared/observe.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

const STEP_RATE = 'github.rate';

/** A-41. Нет числа — ход без факта остатка. Строка лога — в конце хода: `info`, ниже `GITHUB_RATE_FLOOR` — `warn`. */
export async function observeGithubRate(
  db: Kysely<Database>,
  logger: Logger,
  remainingPercent: number | null,
  runStartedAt: Date,
): Promise<void> {
  if (remainingPercent === null || !Number.isInteger(remainingPercent)) {
    logger.info(STEP_RATE, { remainingPercent: null });
    return;
  }
  await publishGithubRate(createEventJournal(db, logger), { remainingPercent, runStartedAt });
  if (rateBelowFloor(remainingPercent)) logger.warn(STEP_RATE, { remainingPercent });
  else logger.info(STEP_RATE, { remainingPercent });
}
