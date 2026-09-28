import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import type { User } from './user.ts';

/** Пустая строка — не логин: сопоставления нет. */
export function normalizeGithubLogin(login: string | null): string | null {
  if (login === null) return null;
  const trimmed = login.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/** GitHub не различает регистр: это один логин. */
export function sameGithubLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Факт сопоставляется только с текущим логином.
 * Пустое поле и прежний ник после смены не совпадают.
 */
export function matchesCurrentGithubLogin(githubLogin: string | null, factLogin: string): boolean {
  const current = normalizeGithubLogin(githubLogin);
  const fact = normalizeGithubLogin(factLogin);
  if (current === null || fact === null) return false;
  return sameGithubLogin(current, fact);
}

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
