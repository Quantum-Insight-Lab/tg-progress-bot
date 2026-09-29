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
