import type { Kysely, Transaction } from 'kysely';
import { admitOrDeny, type AccessGate, type AccessProfile } from '../domain/projects/access.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

async function profileOf(trx: Transaction<Database>, telegramUserId: string): Promise<AccessProfile> {
  const row = await trx
    .selectFrom('users')
    .select(['id', 'is_root'])
    .where('telegram_user_id', '=', telegramUserId)
    .executeTakeFirst();
  if (row === undefined) return { userId: null, isRoot: false, isParticipant: false };
  const member = await trx.selectFrom('project_members').select('id').where('user_id', '=', row.id).executeTakeFirst();
  return { userId: row.id, isRoot: row.is_root, isParticipant: member !== undefined };
}

/** Кто пишет боту: корень, участник или посторонний. Отказ и событие — одна транзакция. */
export function createAccessGate(db: Kysely<Database>, logger: Logger, clock: Clock): AccessGate {
  return {
    screen(input) {
      return db.transaction().execute(async (trx) => admitOrDeny(createEventJournal(trx, logger), clock, await profileOf(trx, input.telegramUserId), input));
    },
  };
}
