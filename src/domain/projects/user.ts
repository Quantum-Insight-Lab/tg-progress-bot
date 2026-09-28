import type { Clock } from '../shared/clock.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Человек: аккаунт Telegram. Логин GitHub к нему записывается отдельно. */
export interface User {
  id: string;
  telegramUserId: string;
  name: string;
  isRoot: boolean;
}

export interface NewUser {
  id: string;
  telegramUserId: string;
  name: string;
}

/** Корень — первый lead. Роль в конкретном проекте здесь не хранится. */
export function isFirstLead(user: User): boolean {
  return user.isRoot;
}

/**
 * Порт таблицы `users` внутри уже открытой транзакции.
 * Блокировка и вставка — обязанности реализации, решение о корне — нет.
 */
export interface UserStore {
  countForUpdate(): Promise<number>;
  insert(user: User): Promise<void>;
}

/** Поиск внутри той же транзакции, что и блокировка `countForUpdate`. */
export interface RegistrationStore extends UserStore {
  findByTelegramUserId(telegramUserId: string): Promise<User | null>;
}

/** Аккаунт, который пришёл с `/start`: id назначает вызывающий. */
export interface StartIdentity {
  telegramUserId: string;
  name: string;
}

export interface StartRegistration {
  user: User;
  created: boolean;
}

/** Порт регистрации для адаптера Telegram. Часы и транзакция — у реализации. */
export interface UserRegistration {
  registerOnStart(input: StartIdentity): Promise<StartRegistration>;
}

/**
 * Корень создаётся одной транзакцией и только когда пользователей ещё нет.
 * Второй вызов корнем никого не делает.
 */
export async function createRoot(store: UserStore, input: NewUser): Promise<User> {
  const existing = await store.countForUpdate();
  if (existing > 0) {
    throw new DomainError(DOMAIN_ERROR.USERS_ALREADY_EXIST, 'Корень создаётся, только когда пользователей ещё нет');
  }
  const user: User = {
    id: input.id,
    telegramUserId: input.telegramUserId,
    name: input.name,
    isRoot: true,
  };
  await store.insert(user);
  return user;
}

function registeredName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new DomainError(DOMAIN_ERROR.BLANK_NAME, 'имя пустое');
  return trimmed;
}

function telegramUserIdOf(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new DomainError(DOMAIN_ERROR.TELEGRAM_USER_ID, 'telegram_user_id');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new DomainError(DOMAIN_ERROR.TELEGRAM_USER_ID, 'telegram_user_id');
  return parsed;
}

async function publishRegistered(journal: EventJournal, clock: Clock, user: User, telegramUserId: number): Promise<void> {
  const result = await emit(journal, {
    type: EVENT_TYPES.USER_REGISTERED,
    source: 'telegram',
    idempotencyKey: user.telegramUserId,
    payload: {
      user_id: user.id,
      telegram_user_id: telegramUserId,
      name: user.name,
      is_root: user.isRoot,
    },
    actor: { id: user.id, role: 'user' },
    subject: { entity: 'User', id: user.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (result.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.REGISTRATION_DUPLICATE, 'user.registered уже записан');
  }
}

/**
 * `/start` в личке. Первый пользователь — корень и первый lead.
 * Следующий только запоминает аккаунт и корнем не становится.
 * Повтор того же аккаунта не пишет второй факт.
 */
export async function registerOnStart(
  store: RegistrationStore,
  journal: EventJournal,
  clock: Clock,
  input: NewUser,
): Promise<StartRegistration> {
  const name = registeredName(input.name);
  const telegramUserId = telegramUserIdOf(input.telegramUserId);
  const normalized: NewUser = { id: input.id, telegramUserId: input.telegramUserId, name };
  const existingCount = await store.countForUpdate();
  const found = await store.findByTelegramUserId(normalized.telegramUserId);
  if (found !== null) return { user: found, created: false };
  const user =
    existingCount === 0
      ? await createRoot(store, normalized)
      : await rememberAccount(store, normalized);
  await publishRegistered(journal, clock, user, telegramUserId);
  return { user, created: true };
}

async function rememberAccount(store: RegistrationStore, input: NewUser): Promise<User> {
  const user: User = {
    id: input.id,
    telegramUserId: input.telegramUserId,
    name: input.name,
    isRoot: false,
  };
  await store.insert(user);
  return user;
}
