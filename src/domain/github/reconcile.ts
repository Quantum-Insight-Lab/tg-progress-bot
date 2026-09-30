import { RECONCILE_INTERVAL } from '../../config/constants.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { ciBranch, type CiStatus } from './ci-status.ts';
import { commitFields, commitKeptInTail } from './commit.ts';
import { defineIssue, ISSUE_STATE_OPEN, type IssueState, type IssueStateReason } from './issue.ts';
import { issueAssigneeSet } from './issue-assignee.ts';
import { pullRequestFields, type PullRequestState } from './pull-request.ts';
import { githubRepositoryId } from './repository.ts';

/** Опрос догоняет пропуск. Повтор того же прогона второе событие не пишет. */
export const RECONCILE_SOURCE = 'system';

export const RECONCILE_ACTOR_ID = 'system';

export const RECONCILE_ACTOR_ROLE = 'system';

export const RECONCILE_SUBJECT = 'Repository';

export const RECONCILE_FACT_ISSUE = 'issue';

export const RECONCILE_FACT_PULL_REQUEST = 'pull_request';

export const RECONCILE_FACT_COMMIT = 'commit';

export const RECONCILE_FACT_DEFAULT_BRANCH_CI = 'default_branch_ci';

export const RECONCILE_FACT_PULL_REQUEST_CI = 'pull_request_ci';

const CANONICAL_ID = 'mirror';

/** Issue в снимке зеркала или GitHub. Проекта в снимке нет. */
export interface ReconcileIssueInput {
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  assignees: readonly string[];
  closedByLogin: string | null;
  updatedAt: string;
}

/** Pull request в снимке зеркала. Ветка головы есть только у снимка GitHub. */
export interface ReconcilePullRequestInput {
  number: number;
  title: string;
  authorLogin: string;
  state: string;
  ciStatus: string | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
}

/** Pull request из GitHub: ветка нужна, чтобы дописать пропущенный CI уже лежащей строки. */
export interface RemotePullRequestInput extends ReconcilePullRequestInput {
  headBranch: string;
}

/** Коммит в снимке. Хвост отбирает сверка, не таблица. */
export interface ReconcileCommitInput {
  sha: string;
  message: string;
  authorLogin: string;
  createdAt: string;
}

/** Зеркало репозитория на момент сверки. */
export interface MirrorSnapshot {
  defaultBranchCi: CiStatus | null;
  issues: readonly ReconcileIssueInput[];
  pullRequests: readonly ReconcilePullRequestInput[];
  commits: readonly ReconcileCommitInput[];
}

/** Снимок GitHub только для чтения. Команд записи в нём нет. */
export interface RemoteMirror {
  defaultBranch: string;
  defaultBranchCi: CiStatus | null;
  issues: readonly ReconcileIssueInput[];
  pullRequests: readonly RemotePullRequestInput[];
  commits: readonly ReconcileCommitInput[];
}

export interface CanonicalIssue {
  number: number;
  title: string;
  state: IssueState;
  stateReason: IssueStateReason | null;
  assignees: readonly string[];
  closedByLogin: string | null;
  updatedAt: string;
}

export interface CanonicalPullRequest {
  number: number;
  title: string;
  authorLogin: string;
  state: PullRequestState;
  ciStatus: CiStatus | null;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
  headBranch: string | null;
}

export interface CanonicalCommit {
  sha: string;
  message: string;
  authorLogin: string;
  createdAt: string;
}

export type MissedMirrorFact =
  | { kind: typeof RECONCILE_FACT_ISSUE; issue: CanonicalIssue }
  | { kind: typeof RECONCILE_FACT_PULL_REQUEST; pullRequest: CanonicalPullRequest }
  | { kind: typeof RECONCILE_FACT_COMMIT; commit: CanonicalCommit }
  | { kind: typeof RECONCILE_FACT_DEFAULT_BRANCH_CI; branch: string; status: CiStatus }
  | { kind: typeof RECONCILE_FACT_PULL_REQUEST_CI; number: number; branch: string; status: CiStatus };

/** Порт чтения GitHub. Реализация не открывает методов записи. */
export interface GithubReconcileSource {
  read(repository: { id: string; owner: string; name: string }, now: Date): Promise<RemoteMirror>;
  /** Остаток лимита App в процентах. Нет метода — ход без M-17. */
  rateRemainingPercent?(now: Date): Promise<number | null>;
}

/** Репозиторий, который зеркало уже знает. */
export interface ReconcileRepository {
  id: string;
  owner: string;
  name: string;
}

interface IssueIndex {
  byNumber: Map<number, CanonicalIssue>;
}

interface PullRequestIndex {
  byNumber: Map<number, CanonicalPullRequest>;
}

interface CommitIndex {
  bySha: Map<string, CanonicalCommit>;
}

function millisecondsInMinute(): number {
  return Date.UTC(0, 0, 1, 0, 1) - Date.UTC(0, 0, 1, 0, 0);
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function orderedLogins(logins: readonly string[]): string[] {
  return issueAssigneeSet(CANONICAL_ID, logins)
    .map((assignee) => assignee.login)
    .sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
}

function sameLogins(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalIssue(repositoryId: string, input: ReconcileIssueInput): CanonicalIssue {
  const open = input.state.trim() === ISSUE_STATE_OPEN;
  const issue = defineIssue({
    id: CANONICAL_ID,
    repositoryId,
    issueNumber: input.number,
    title: input.title,
    state: input.state,
    stateReason: open ? null : input.stateReason,
    closedByLogin: open ? null : input.closedByLogin,
    updatedAt: input.updatedAt,
    closedAt: null,
  });
  return {
    number: issue.issueNumber,
    title: issue.title,
    state: issue.state,
    stateReason: issue.stateReason,
    assignees: orderedLogins(input.assignees),
    closedByLogin: issue.closedByLogin,
    updatedAt: issue.updatedAt,
  };
}

function canonicalPullRequest(
  repositoryId: string,
  input: ReconcilePullRequestInput,
  headBranch: string | null,
): CanonicalPullRequest {
  const pullRequest = pullRequestFields({
    repositoryId,
    pullRequestNumber: input.number,
    title: input.title,
    authorLogin: input.authorLogin,
    state: input.state,
    ciStatus: input.ciStatus,
    updatedAt: input.updatedAt,
    mergedAt: input.mergedAt,
    mergedByLogin: input.mergedByLogin,
  });
  return {
    number: pullRequest.pullRequestNumber,
    title: pullRequest.title,
    authorLogin: pullRequest.authorLogin,
    state: pullRequest.state,
    ciStatus: pullRequest.ciStatus,
    updatedAt: pullRequest.updatedAt,
    mergedAt: pullRequest.mergedAt,
    mergedByLogin: pullRequest.mergedByLogin,
    headBranch: headBranch === null || headBranch.trim().length === 0 ? null : ciBranch(headBranch),
  };
}

function canonicalCommit(repositoryId: string, input: ReconcileCommitInput): CanonicalCommit {
  const commit = commitFields({
    repositoryId,
    sha: input.sha,
    message: input.message,
    authorLogin: input.authorLogin,
    createdAt: input.createdAt,
  });
  return {
    sha: commit.sha,
    message: commit.message,
    authorLogin: commit.authorLogin,
    createdAt: commit.createdAt,
  };
}

function indexIssues(repositoryId: string, issues: readonly ReconcileIssueInput[]): IssueIndex {
  const byNumber = new Map<number, CanonicalIssue>();
  for (const issue of issues) {
    const canonical = canonicalIssue(repositoryId, issue);
    if (byNumber.has(canonical.number)) continue;
    byNumber.set(canonical.number, canonical);
  }
  return { byNumber };
}

function indexPullRequests(repositoryId: string, pullRequests: readonly ReconcilePullRequestInput[]): PullRequestIndex {
  const byNumber = new Map<number, CanonicalPullRequest>();
  for (const pullRequest of pullRequests) {
    const headBranch = 'headBranch' in pullRequest && typeof pullRequest.headBranch === 'string' ? pullRequest.headBranch : null;
    const canonical = canonicalPullRequest(repositoryId, pullRequest, headBranch);
    if (byNumber.has(canonical.number)) continue;
    byNumber.set(canonical.number, canonical);
  }
  return { byNumber };
}

function indexCommits(repositoryId: string, commits: readonly ReconcileCommitInput[], now: Date): CommitIndex {
  const bySha = new Map<string, CanonicalCommit>();
  for (const commit of commits) {
    const canonical = canonicalCommit(repositoryId, commit);
    if (!commitKeptInTail(canonical.createdAt, now)) continue;
    if (bySha.has(canonical.sha)) continue;
    bySha.set(canonical.sha, canonical);
  }
  return { bySha };
}

function byNumber(left: { number: number }, right: { number: number }): number {
  if (left.number < right.number) return -1;
  if (left.number > right.number) return 1;
  return 0;
}

function sameIssue(left: CanonicalIssue, right: CanonicalIssue): boolean {
  return (
    left.title === right.title &&
    left.state === right.state &&
    left.stateReason === right.stateReason &&
    left.closedByLogin === right.closedByLogin &&
    sameInstant(left.updatedAt, right.updatedAt) &&
    sameLogins(left.assignees, right.assignees)
  );
}

function samePullRequest(left: CanonicalPullRequest, right: CanonicalPullRequest): boolean {
  return (
    left.title === right.title &&
    left.authorLogin === right.authorLogin &&
    left.state === right.state &&
    left.mergedByLogin === right.mergedByLogin &&
    sameInstant(left.updatedAt, right.updatedAt) &&
    (left.mergedAt === null
      ? right.mergedAt === null
      : right.mergedAt !== null && sameInstant(left.mergedAt, right.mergedAt))
  );
}

function sameCommit(left: CanonicalCommit, right: CanonicalCommit): boolean {
  return (
    left.message === right.message &&
    left.authorLogin === right.authorLogin &&
    sameInstant(left.createdAt, right.createdAt)
  );
}

/** Зеркало новее снимка GitHub: webhook уже догнал факт, опрос его не затирает. */
function mirrorIsNewer(mirrorAt: string, remoteAt: string): boolean {
  return Date.parse(mirrorAt) > Date.parse(remoteAt);
}

/**
 * Пропущенные доставки: в зеркале нет факта или он старше снимка GitHub.
 * Совпавший факт повторно не доставляется. Строки, которых в снимке нет, опрос не снимает.
 * Коммит старше хвоста пропуском не считается.
 */
export function missedMirrorFacts(
  repositoryId: string,
  mirror: MirrorSnapshot,
  remote: RemoteMirror,
  now: Date,
): MissedMirrorFact[] {
  const id = githubRepositoryId(repositoryId);
  const mirrorIssues = indexIssues(id, mirror.issues);
  const remoteIssues = indexIssues(id, remote.issues);
  const mirrorPulls = indexPullRequests(id, mirror.pullRequests);
  const remotePulls = indexPullRequests(id, remote.pullRequests);
  const mirrorCommits = indexCommits(id, mirror.commits, now);
  const remoteCommits = indexCommits(id, remote.commits, now);
  const missed: MissedMirrorFact[] = [];

  const issues = [...remoteIssues.byNumber.values()].sort(byNumber);
  for (const issue of issues) {
    const local = mirrorIssues.byNumber.get(issue.number);
    if (local !== undefined && mirrorIsNewer(local.updatedAt, issue.updatedAt)) continue;
    if (local !== undefined && sameIssue(local, issue)) continue;
    missed.push({ kind: RECONCILE_FACT_ISSUE, issue });
  }

  const pullRequests = [...remotePulls.byNumber.values()].sort(byNumber);
  for (const pullRequest of pullRequests) {
    const local = mirrorPulls.byNumber.get(pullRequest.number);
    if (local === undefined || !mirrorIsNewer(local.updatedAt, pullRequest.updatedAt)) {
      if (local === undefined || !samePullRequest(local, pullRequest)) {
        missed.push({ kind: RECONCILE_FACT_PULL_REQUEST, pullRequest });
      }
    }
    if (pullRequest.ciStatus !== null && pullRequest.headBranch !== null) {
      const localCi = local?.ciStatus ?? null;
      if (localCi !== pullRequest.ciStatus) {
        missed.push({
          kind: RECONCILE_FACT_PULL_REQUEST_CI,
          number: pullRequest.number,
          branch: pullRequest.headBranch,
          status: pullRequest.ciStatus,
        });
      }
    }
  }

  const commits = [...remoteCommits.bySha.values()].sort((left, right) => {
    if (left.sha < right.sha) return -1;
    if (left.sha > right.sha) return 1;
    return 0;
  });
  for (const commit of commits) {
    const local = mirrorCommits.bySha.get(commit.sha);
    if (local !== undefined && sameCommit(local, commit)) continue;
    missed.push({ kind: RECONCILE_FACT_COMMIT, commit });
  }

  if (remote.defaultBranchCi !== null && remote.defaultBranchCi !== mirror.defaultBranchCi) {
    missed.push({
      kind: RECONCILE_FACT_DEFAULT_BRANCH_CI,
      branch: ciBranch(remote.defaultBranch),
      status: remote.defaultBranchCi,
    });
  }
  return missed;
}

/** Ключ `github.reconciled`: репозиторий и момент старта прогона. */
export function reconcileIdempotencyKey(repositoryId: string, runStartedAt: Date): string {
  const id = githubRepositoryId(repositoryId);
  return `${EVENT_TYPES.GITHUB_RECONCILED}+${id}+${runStartedAt.toISOString()}`;
}

/**
 * Пора ли снова читать GitHub.
 * Первый прогон — сразу. Следующий — не раньше `RECONCILE_INTERVAL`.
 */
export function reconcileIsDue(lastRunStartedAt: Date | null, now: Date): boolean {
  if (lastRunStartedAt === null) return true;
  const elapsed = now.getTime() - lastRunStartedAt.getTime();
  if (elapsed < 0) return false;
  return elapsed >= RECONCILE_INTERVAL * millisecondsInMinute();
}

/**
 * Записать `github.reconciled`. Повтор ключа второе событие не пишет.
 * Задачи и блокеры этот акт не меняет: строки CI и PR остаются выводом из зеркала.
 */
export async function publishGithubReconciled(
  journal: EventJournal,
  input: { repositoryId: string; restoredFacts: number; runStartedAt: Date },
): Promise<{ applied: boolean; eventId: string }> {
  const repositoryId = githubRepositoryId(input.repositoryId);
  const published = await emit(journal, {
    type: EVENT_TYPES.GITHUB_RECONCILED,
    source: RECONCILE_SOURCE,
    idempotencyKey: reconcileIdempotencyKey(repositoryId, input.runStartedAt),
    payload: { repository_id: repositoryId, restored_facts: input.restoredFacts },
    actor: { id: RECONCILE_ACTOR_ID, role: RECONCILE_ACTOR_ROLE },
    subject: { entity: RECONCILE_SUBJECT, id: repositoryId },
    occurredAt: input.runStartedAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  return { applied: true, eventId: published.row.id };
}
