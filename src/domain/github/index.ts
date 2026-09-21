/** Контекст github: зеркальные факты. Не импортирует projects и tasks (S-2). */

export { GITHUB_ACTOR, type GithubFactEvent } from "./types.js";
export {
  recordChecksFailed,
  recordIssueLinked,
  recordIssueUpdated,
  recordMilestoneUpdated,
  recordPullRequestUpdated,
} from "./facts.js";
export { githubSyncLagMs, githubSignalsAllowed, isReconcileDue } from "./reconcile.js";
