import type { Kysely } from 'kysely';
import { publishGithubRate } from '../domain/github/rate.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

/** A-41. Нет числа — ход без факта остатка. */
export async function observeGithubRate(
  db: Kysely<Database>,
  remainingPercent: number | null,
  runStartedAt: Date,
): Promise<void> {
  if (remainingPercent === null || !Number.isInteger(remainingPercent)) return;
  await publishGithubRate(createEventJournal(db), { remainingPercent, runStartedAt });
}
