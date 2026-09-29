/**
 * Часть Progress Engine «GitHub mirror» (B-3).
 * Зеркало репозитория — одна строка `repositories` на id GitHub.
 * Приём webhook — подпись и публикация факта в `src/github/webhook.ts`.
 * Issue пишется в зеркало репозитория по природному ключу.
 * Assignees пишутся из `github.issue_changed`. Связи — из `github.issue_links_changed`.
 * Milestone пишется из `github.milestone_changed` по природному ключу.
 * Таблицы PR и остальных объектов — в своих issues.
 */
export const githubMirrorPart = { id: 'github-mirror', scope: 'repository' } as const;
