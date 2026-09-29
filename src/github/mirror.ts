/**
 * Часть Progress Engine «GitHub mirror» (B-3).
 * Зеркало репозитория — одна строка `repositories` на id GitHub.
 * Приём webhook — подпись и публикация факта в `src/github/webhook.ts`.
 * Issue пишется в зеркало репозитория по природному ключу.
 * Assignees пишутся из `github.issue_changed`. Связи — из `github.issue_links_changed`.
 * Milestone пишется из `github.milestone_changed` по природному ключу.
 * Pull request пишется из `github.pull_request_changed` по природному ключу.
 * CI пишется из `github.workflow_completed`: основная ветка и уже лежащие pull request.
 * Коммиты пишутся из `github.commits_pushed`: хвост репозитория, не вся история.
 */
export const githubMirrorPart = { id: 'github-mirror', scope: 'repository' } as const;
