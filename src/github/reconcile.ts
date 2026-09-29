import { workflowConclusion } from '../domain/github/ci-status.ts';
import { commitTailStartsAt } from '../domain/github/commit.ts';
import type { RemoteMirror, RemotePullRequestInput, ReconcileCommitInput, ReconcileIssueInput } from '../domain/github/reconcile.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { createGithubInstallationApp, type GithubAppCredentials } from './client.ts';

const ROUTE_ISSUES = 'GET /repos/{owner}/{repo}/issues';
const ROUTE_PULLS = 'GET /repos/{owner}/{repo}/pulls';
const ROUTE_COMMITS = 'GET /repos/{owner}/{repo}/commits';
const ROUTE_RUNS = 'GET /repos/{owner}/{repo}/actions/runs';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const STATE_ALL = 'all';
const RUN_COMPLETED = 'completed';
const STATE_MERGED = 'merged';

interface GithubGet {
  request(route: string, parameters: Record<string, string | number>): Promise<{ data: unknown }>;
}

interface InstalledRepository {
  reader: GithubGet;
  defaultBranch: string;
}

/** Чтение GitHub для одного репозитория. Записи в эти методы не входят. */
export interface GithubReconcileApi {
  issues(owner: string, repo: string): Promise<readonly unknown[]>;
  pullRequests(owner: string, repo: string): Promise<readonly unknown[]>;
  commits(owner: string, repo: string, since: string): Promise<readonly unknown[]>;
  latestConclusion(owner: string, repo: string, selector: { branch: string } | { sha: string }): Promise<string | null>;
}

/** Маршруты сверки. Все чтения. */
export function githubReconcileRoutes(): readonly string[] {
  return [ROUTE_ISSUES, ROUTE_PULLS, ROUTE_COMMITS, ROUTE_RUNS];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function whole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function login(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return text(value.login);
}

function required(value: string | null, message: string): string {
  if (value === null) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, message);
  return value;
}

function parseIssue(value: unknown): ReconcileIssueInput | null {
  if (!isRecord(value)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'снимок issue не прочитан');
  if (isRecord(value.pull_request)) return null;
  const assignees = Array.isArray(value.assignees) ? value.assignees.map((item) => login(item)).filter((item): item is string => item !== null) : [];
  return {
    number: requiredNumber(value.number, 'номер issue — число GitHub'),
    title: required(text(value.title), 'у issue есть название'),
    state: required(text(value.state), 'состояние issue'),
    stateReason: value.state_reason === null || value.state_reason === undefined ? null : text(value.state_reason),
    assignees,
    closedByLogin: value.closed_by === null || value.closed_by === undefined ? null : login(value.closed_by),
    updatedAt: required(text(value.updated_at), 'дата issue'),
  };
}

function requiredNumber(value: unknown, message: string): number {
  const number = whole(value);
  if (number === null) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, message);
  return number;
}

function parsePull(value: unknown): { pullRequest: Omit<RemotePullRequestInput, 'ciStatus'>; sha: string | null } {
  if (!isRecord(value)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'снимок pull request не прочитан');
  const head = isRecord(value.head) ? value.head : null;
  const merged = value.merged === true;
  const state = text(value.state);
  return {
    sha: head === null ? null : text(head.sha),
    pullRequest: {
      number: requiredNumber(value.number, 'номер pull request — число GitHub'),
      title: required(text(value.title), 'у pull request есть название'),
      authorLogin: required(login(value.user), 'у pull request есть автор'),
      state: merged ? STATE_MERGED : required(state, 'состояние pull request'),
      updatedAt: required(text(value.updated_at), 'дата pull request'),
      mergedAt: value.merged_at === null || value.merged_at === undefined ? null : text(value.merged_at),
      mergedByLogin: value.merged_by === null || value.merged_by === undefined ? null : login(value.merged_by),
      headBranch: head === null ? '' : (text(head.ref) ?? ''),
    },
  };
}

function parseCommit(value: unknown): ReconcileCommitInput | null {
  if (!isRecord(value)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'снимок коммита не прочитан');
  const authorLogin = login(value.author);
  if (authorLogin === null) return null;
  const commit = isRecord(value.commit) ? value.commit : null;
  const author = commit !== null && isRecord(commit.author) ? commit.author : null;
  return {
    sha: required(text(value.sha), 'у коммита есть sha'),
    message: required(commit === null ? null : text(commit.message), 'у коммита есть сообщение'),
    authorLogin,
    createdAt: required(author === null ? null : text(author.date), 'дата коммита'),
  };
}

function conclusionOf(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.workflow_runs)) return null;
  const first = body.workflow_runs[0];
  if (!isRecord(first)) return null;
  if (first.conclusion === null || first.conclusion === undefined) return null;
  return text(first.conclusion);
}

function listOf(body: unknown, message: string): unknown[] {
  if (!Array.isArray(body)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, message);
  return body;
}

/**
 * Снимок репозитория из чтения API.
 * Issue, который GitHub отдал как pull request, в долю не входит.
 * Коммит без логина автора в хвост не входит.
 */
export async function remoteMirrorFromApi(
  api: GithubReconcileApi,
  repository: { owner: string; name: string; defaultBranch: string },
  now: Date,
): Promise<RemoteMirror> {
  const owner = repository.owner;
  const repo = repository.name;
  const since = new Date(commitTailStartsAt(now)).toISOString();
  const [issueBodies, pullBodies, commitBodies, branchConclusion] = await Promise.all([
    api.issues(owner, repo),
    api.pullRequests(owner, repo),
    api.commits(owner, repo, since),
    api.latestConclusion(owner, repo, { branch: repository.defaultBranch }),
  ]);
  const issues: ReconcileIssueInput[] = [];
  for (const body of issueBodies) {
    const issue = parseIssue(body);
    if (issue !== null) issues.push(issue);
  }
  const pullRequests: RemotePullRequestInput[] = [];
  for (const body of pullBodies) {
    const parsed = parsePull(body);
    const conclusion =
      parsed.sha === null ? null : await api.latestConclusion(owner, repo, { sha: parsed.sha });
    pullRequests.push({
      ...parsed.pullRequest,
      ciStatus: workflowConclusion(conclusion),
    });
  }
  const commits: ReconcileCommitInput[] = [];
  for (const body of commitBodies) {
    const commit = parseCommit(body);
    if (commit !== null) commits.push(commit);
  }
  return {
    defaultBranch: repository.defaultBranch,
    defaultBranchCi: workflowConclusion(branchConclusion),
    issues,
    pullRequests,
    commits,
  };
}

async function collectPages(
  reader: GithubGet,
  route: string,
  parameters: Record<string, string | number>,
  message: string,
): Promise<unknown[]> {
  const found: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await reader.request(route, { ...parameters, per_page: PAGE_SIZE, page });
    const batch = listOf(response.data, message);
    found.push(...batch);
    if (batch.length < PAGE_SIZE) return found;
  }
  throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'снимок GitHub не поместился в страницы сверки');
}

function apiFrom(reader: GithubGet): GithubReconcileApi {
  return {
    issues(owner, repo) {
      return collectPages(reader, ROUTE_ISSUES, { owner, repo, state: STATE_ALL }, 'список issues не прочитан');
    },
    pullRequests(owner, repo) {
      return collectPages(reader, ROUTE_PULLS, { owner, repo, state: STATE_ALL }, 'список pull request не прочитан');
    },
    commits(owner, repo, since) {
      return collectPages(reader, ROUTE_COMMITS, { owner, repo, since }, 'хвост коммитов не прочитан');
    },
    async latestConclusion(owner, repo, selector) {
      const parameters: Record<string, string | number> = { owner, repo, status: RUN_COMPLETED, per_page: 1 };
      if ('branch' in selector) parameters.branch = selector.branch;
      else parameters.head_sha = selector.sha;
      const response = await reader.request(ROUTE_RUNS, parameters);
      return conclusionOf(response.data);
    },
  };
}

/**
 * Чтение зеркала через GitHub App.
 * Список установки на один прогон общий. Методов записи нет.
 */
export function createGithubReconcileSource(credentials: GithubAppCredentials): {
  read(repository: { id: string; owner: string; name: string }, now: Date): Promise<RemoteMirror>;
} {
  const app = createGithubInstallationApp(credentials);
  let cachedAt: number | null = null;
  let installed = new Map<string, InstalledRepository>();

  async function installation(repositoryId: string, now: Date): Promise<InstalledRepository> {
    if (cachedAt !== now.getTime()) {
      const next = new Map<string, InstalledRepository>();
      try {
        for await (const item of app.eachRepository.iterator()) {
          const branch = item.repository.default_branch.trim();
          if (branch.length === 0) continue;
          next.set(String(item.repository.id), {
            reader: item.octokit as GithubGet,
            defaultBranch: branch,
          });
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'установка GitHub App не прочитана');
      }
      installed = next;
      cachedAt = now.getTime();
    }
    const found = installed.get(repositoryId);
    if (found === undefined) {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'репозиторий установки не прочитан');
    }
    return found;
  }

  return {
    async read(repository, now) {
      try {
        const target = await installation(repository.id, now);
        return await remoteMirrorFromApi(
          apiFrom(target.reader),
          { owner: repository.owner, name: repository.name, defaultBranch: target.defaultBranch },
          now,
        );
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'сверка GitHub не прочитана');
      }
    },
  };
}
