import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Отказ пишет система, не сам посторонний. */
export const ACCESS_ACTOR_ID = 'system';

export const ACCESS_ACTOR_ROLE = 'system';

export const ACCESS_SUBJECT = 'User';

/** Факты для guard: корень или участник хотя бы одного проекта. */
export interface AccessProfile {
  userId: string | null;
  isRoot: boolean;
  isParticipant: boolean;
}

export interface AccessAttempt {
  telegramUserId: string;
  updateKind: string;
  idempotencyKey: string;
}

/** Порт guard для адаптера Telegram. Транзакция и журнал — у реализации. */
export interface AccessGate {
  screen(input: AccessAttempt): Promise<'allow' | 'deny'>;
}

/**
 * Бот отвечает корню и участникам проекта.
 * Посторонний и тот, кого ещё не добавили, сюда не проходят.
 */
export function mayAnswer(profile: AccessProfile): boolean {
  return profile.isRoot || profile.isParticipant;
}

function telegramUserIdOf(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new DomainError(DOMAIN_ERROR.TELEGRAM_USER_ID, 'telegram_user_id');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new DomainError(DOMAIN_ERROR.TELEGRAM_USER_ID, 'telegram_user_id');
  return parsed;
}

/**
 * Постороннему — отказ. Факт `access.denied` дописывается в журнал.
 * Повтор того же обновления второй строки не создаёт.
 * Неизвестного пользователя этот акт в `users` не записывает.
 */
export async function admitOrDeny(
  journal: EventJournal,
  clock: Clock,
  profile: AccessProfile,
  input: AccessAttempt,
): Promise<'allow' | 'deny'> {
  if (mayAnswer(profile)) return 'allow';
  const telegramUserId = telegramUserIdOf(input.telegramUserId);
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ACCESS_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const updateKind = input.updateKind.trim();
  if (updateKind.length === 0) throw new DomainError(DOMAIN_ERROR.ACCESS_UPDATE_KIND, 'вид обновления пуст');
  const subjectId = profile.userId === null || profile.userId.trim().length === 0 ? input.telegramUserId : profile.userId;
  await emit(journal, {
    type: EVENT_TYPES.ACCESS_DENIED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      telegram_user_id: telegramUserId,
      update_kind: updateKind,
    },
    actor: { id: ACCESS_ACTOR_ID, role: ACCESS_ACTOR_ROLE },
    subject: { entity: ACCESS_SUBJECT, id: subjectId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  return 'deny';
}
