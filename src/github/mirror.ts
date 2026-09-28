/**
 * Часть Progress Engine «GitHub mirror» (B-3).
 * Зеркало репозитория — одна строка `repositories` на id GitHub.
 * Приём webhook GitHub — в своей issue.
 */
export const githubMirrorPart = { id: 'github-mirror', scope: 'repository' } as const;
