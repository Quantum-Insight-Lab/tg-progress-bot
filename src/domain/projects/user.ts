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
