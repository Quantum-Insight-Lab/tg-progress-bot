import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import type { User } from './user.ts';

export { matchesCurrentGithubLogin, normalizeGithubLogin, sameGithubLogin } from '../shared/github-login-match.ts';

/** В событии логин меняет сам человек. */
export const GITHUB_LOGIN_ACTOR_ROLE = 'user';

export const GITHUB_LOGIN_SUBJECT = 'User';

/** В поле остаётся только текущий логин. Старый не хранится. */
export function withCurrentGithubLogin(user: User, login: string | null): User {
  return { ...user, githubLogin: normalizeGithubLogin(login) };
}

/** Один непустой логин принадлежит одному пользователю бота. */
export function assertGithubLoginAvailable(ownerUserId: string | null, userId: string): void {
  if (ownerUserId !== null && ownerUserId !== userId) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_TAKEN, 'Один логин GitHub принадлежит одному пользователю бота');
  }
}

/**
 * Действие GitHub в момент показа.
 * Имя логина остаётся на факте. К человеку в боте оно приклеивается, только если текущий логин совпал.
 */
export interface ShownGithubAct {
  login: string;
  userId: string | null;
}

/** Сопоставление в момент показа: внешнего ключа от факта к человеку нет. */
export function showGithubAct(
  people: readonly { id: string; githubLogin: string | null }[],
  factLogin: string,
): ShownGithubAct {
  const login = normalizeGithubLogin(factLogin);
  if (login === null) return { login: factLogin.trim(), userId: null };
  const match = people.find((person) => matchesCurrentGithubLogin(person.githubLogin, login));
  return { login, userId: match === undefined ? null : match.id };
}

/** Порт текущего логина внутри уже открытой транзакции. */
export interface GithubLoginStore {
  ownerId(login: string): Promise<string | null>;
  save(userId: string, login: string | null): Promise<void>;
}

/** Свой логин. `skip` не затирает уже записанный. Чужой `userId` домен отклоняет. */
export interface OwnGithubLogin {
  actor: User | null;
  userId: string;
  chat: string;
  login: string | null;
  skip: boolean;
  idempotencyKey: string;
}

/** Порт для адаптера Telegram. Часы и транзакция — у реализации. */
export interface GithubLoginActions {
  find(telegramUserId: string): Promise<User | null>;
  set(input: {
    telegramUserId: string;
    chat: string;
    login: string | null;
    skip: boolean;
    idempotencyKey: string;
  }): Promise<User>;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  return key;
}

/**
 * Человек записывает свой логин GitHub в личке.
 * Пропуск не требует логина и не стирает уже записанный.
 * Повтор того же ключа не пишет второй факт и не меняет поле.
 */
export async function setOwnGithubLogin(
  store: GithubLoginStore,
  journal: EventJournal,
  clock: Clock,
  input: OwnGithubLogin,
): Promise<User> {
  if (input.chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_CHAT, 'логин GitHub записывается в личке');
  }
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const actor = input.actor;
  if (actor === null) throw new DomainError(DOMAIN_ERROR.USER_NOT_FOUND, 'Пользователь не найден');
  if (actor.id !== input.userId) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_ACTOR, 'логин GitHub меняет сам человек');
  }
  if (input.skip && actor.githubLogin !== null) return actor;
  const next = input.skip ? null : withCurrentGithubLogin(actor, input.login).githubLogin;
  if (next !== null) assertGithubLoginAvailable(await store.ownerId(next), actor.id);
  await store.save(actor.id, next);
  const published = await emit(journal, {
    type: EVENT_TYPES.USER_GITHUB_LOGIN_SET,
    source: 'telegram',
    idempotencyKey,
    payload: {
      user_id: actor.id,
      github_login: next,
    },
    actor: { id: actor.id, role: GITHUB_LOGIN_ACTOR_ROLE },
    subject: { entity: GITHUB_LOGIN_SUBJECT, id: actor.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_DUPLICATE, 'user.github_login_set уже записан');
  }
  return { ...actor, githubLogin: next };
}
