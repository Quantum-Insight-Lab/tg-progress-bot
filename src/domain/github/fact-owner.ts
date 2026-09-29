import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { matchesCurrentGithubLogin, normalizeGithubLogin } from '../shared/github-login-match.ts';
import type { Commit } from './commit.ts';
import { ISSUE_STATE_CLOSED, type Issue } from './issue.ts';
import type { PullRequest } from './pull-request.ts';
import { githubRepositoryId } from './repository.ts';

/** Общий факт репозитория: виден каждому проекту, куда репозиторий подключён. */
export const GITHUB_OWNERSHIP_REPOSITORY = 'repository';

/** Личный факт: виден проектам, где логин действующего лица совпал с участником. */
export const GITHUB_OWNERSHIP_PERSONAL = 'personal';

/** Строка общего факта. Логина участника у неё нет. */
export const GITHUB_FACT_REPOSITORY = 'repository';

/** Для PR действующее лицо — автор. */
export const GITHUB_FACT_PULL_REQUEST = 'pull_request';

/** Для коммита действующее лицо — автор. */
export const GITHUB_FACT_COMMIT = 'commit';

/** Для закрытого issue действующее лицо — кто его закрыл. */
export const GITHUB_FACT_CLOSED_ISSUE = 'closed_issue';

export type GithubOwnership = typeof GITHUB_OWNERSHIP_REPOSITORY | typeof GITHUB_OWNERSHIP_PERSONAL;

export type PersonalFactKind =
  | typeof GITHUB_FACT_PULL_REQUEST
  | typeof GITHUB_FACT_COMMIT
  | typeof GITHUB_FACT_CLOSED_ISSUE;

export type GithubFactKind = typeof GITHUB_FACT_REPOSITORY | PersonalFactKind;

/** Проект в момент показа: репозиторий подключён или нет. */
export interface OwnershipProject {
  projectId: string;
  repositoryId: string | null;
}

/** Участник в момент показа. Внешнего ключа от факта к человеку нет. */
export interface OwnershipMember {
  projectId: string;
  userId: string;
  githubLogin: string | null;
}

/** Общий факт. Какой именно (красный CI) решает акт, который его сюда кладёт. */
export interface RepositoryFact {
  ownership: typeof GITHUB_OWNERSHIP_REPOSITORY;
  repositoryId: string;
  key: string;
}

/** Личный факт. Кто действующее лицо, решает эта функция, не вызывающий код. */
export type PersonalFact =
  | {
      ownership: typeof GITHUB_OWNERSHIP_PERSONAL;
      kind: typeof GITHUB_FACT_PULL_REQUEST;
      pullRequest: Pick<PullRequest, 'repositoryId' | 'pullRequestNumber' | 'authorLogin'>;
    }
  | {
      ownership: typeof GITHUB_OWNERSHIP_PERSONAL;
      kind: typeof GITHUB_FACT_COMMIT;
      commit: Pick<Commit, 'repositoryId' | 'sha' | 'authorLogin'>;
    }
  | {
      ownership: typeof GITHUB_OWNERSHIP_PERSONAL;
      kind: typeof GITHUB_FACT_CLOSED_ISSUE;
      issue: Pick<Issue, 'state' | 'repositoryId' | 'issueNumber' | 'closedByLogin'>;
    };

export type GithubFact = RepositoryFact | PersonalFact;

/** Строка факта на одном проекте. Внутри проекта один ключ — одна строка. */
export interface OwnedFactLine {
  ownership: GithubOwnership;
  kind: GithubFactKind;
  projectId: string;
  userId: string | null;
  repositoryId: string;
  key: string;
  actorLogin: string | null;
}

/** Автор, как он лежит в зеркале. Чужой логин отсюда не стирается. */
export interface MirrorAuthor {
  kind: PersonalFactKind;
  repositoryId: string;
  key: string;
  login: string | null;
}

/** Куда факт попал и какой логин остался автором зеркала. */
export interface GithubFactOwnership {
  lines: OwnedFactLine[];
  mirrorAuthors: MirrorAuthor[];
}

interface PersonalReading {
  kind: PersonalFactKind;
  repositoryId: string;
  key: string;
  actorLogin: string | null;
}

function factKey(value: string): string {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_FACT_KEY, 'У факта GitHub есть ключ внутри репозитория');
  }
  return key;
}

function readPersonal(fact: PersonalFact): PersonalReading | null {
  switch (fact.kind) {
    case GITHUB_FACT_PULL_REQUEST:
      return {
        kind: fact.kind,
        repositoryId: fact.pullRequest.repositoryId,
        key: factKey(String(fact.pullRequest.pullRequestNumber)),
        actorLogin: fact.pullRequest.authorLogin,
      };
    case GITHUB_FACT_COMMIT:
      return {
        kind: fact.kind,
        repositoryId: fact.commit.repositoryId,
        key: factKey(fact.commit.sha),
        actorLogin: fact.commit.authorLogin,
      };
    case GITHUB_FACT_CLOSED_ISSUE:
      if (fact.issue.state !== ISSUE_STATE_CLOSED) return null;
      return {
        kind: fact.kind,
        repositoryId: fact.issue.repositoryId,
        key: factKey(String(fact.issue.issueNumber)),
        actorLogin: fact.issue.closedByLogin,
      };
    default: {
      const unreachable: never = fact;
      return unreachable;
    }
  }
}

function connectedProjectIds(repositoryId: string, projects: readonly OwnershipProject[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const project of projects) {
    if (project.repositoryId === null) continue;
    if (githubRepositoryId(project.repositoryId) !== repositoryId) continue;
    const projectId = project.projectId.trim();
    if (projectId.length === 0 || seen.has(projectId)) continue;
    seen.add(projectId);
    ids.push(projectId);
  }
  return ids;
}

function lineId(line: OwnedFactLine): string {
  return `${line.ownership}\n${line.projectId}\n${line.kind}\n${line.repositoryId}\n${line.key}`;
}

function authorId(author: MirrorAuthor): string {
  return `${author.kind}\n${author.repositoryId}\n${author.key}`;
}

function placeRepository(fact: RepositoryFact, projects: readonly OwnershipProject[]): OwnedFactLine[] {
  const repositoryId = githubRepositoryId(fact.repositoryId);
  const key = factKey(fact.key);
  return connectedProjectIds(repositoryId, projects).map((projectId) => ({
    ownership: GITHUB_OWNERSHIP_REPOSITORY,
    kind: GITHUB_FACT_REPOSITORY,
    projectId,
    userId: null,
    repositoryId,
    key,
    actorLogin: null,
  }));
}

function placePersonal(
  reading: PersonalReading,
  projects: readonly OwnershipProject[],
  members: readonly OwnershipMember[],
): OwnedFactLine[] {
  const repositoryId = githubRepositoryId(reading.repositoryId);
  const login = normalizeGithubLogin(reading.actorLogin);
  if (login === null) return [];
  const connected = new Set(connectedProjectIds(repositoryId, projects));
  const seen = new Set<string>();
  const lines: OwnedFactLine[] = [];
  for (const member of members) {
    const projectId = member.projectId.trim();
    const userId = member.userId.trim();
    if (projectId.length === 0 || userId.length === 0) continue;
    if (!connected.has(projectId)) continue;
    if (!matchesCurrentGithubLogin(member.githubLogin, login)) continue;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    lines.push({
      ownership: GITHUB_OWNERSHIP_PERSONAL,
      kind: reading.kind,
      projectId,
      userId,
      repositoryId,
      key: reading.key,
      actorLogin: login,
    });
  }
  return lines;
}

/**
 * Единственная принадлежность факта GitHub.
 * Два правила: общий факт виден каждому проекту репозитория;
 * личный — только где человек участник и репозиторий подключён.
 * Логин сопоставляется сейчас, без внешнего ключа.
 * Чужой логин не попадает ни в один проект, в зеркале остаётся автором.
 * Один и тот же ключ внутри проекта — одна строка; в двух проектах автора — в обоих.
 */
export function ownGithubFacts(
  facts: readonly GithubFact[],
  projects: readonly OwnershipProject[],
  members: readonly OwnershipMember[],
): GithubFactOwnership {
  const lines: OwnedFactLine[] = [];
  const mirrorAuthors: MirrorAuthor[] = [];
  const seenLines = new Set<string>();
  const seenAuthors = new Set<string>();
  for (const fact of facts) {
    if (fact.ownership === GITHUB_OWNERSHIP_REPOSITORY) {
      for (const line of placeRepository(fact, projects)) {
        const id = lineId(line);
        if (seenLines.has(id)) continue;
        seenLines.add(id);
        lines.push(line);
      }
      continue;
    }
    const reading = readPersonal(fact);
    if (reading === null) continue;
    const author: MirrorAuthor = {
      kind: reading.kind,
      repositoryId: githubRepositoryId(reading.repositoryId),
      key: reading.key,
      login: normalizeGithubLogin(reading.actorLogin),
    };
    const authorKey = authorId(author);
    if (!seenAuthors.has(authorKey)) {
      seenAuthors.add(authorKey);
      mirrorAuthors.push(author);
    }
    for (const line of placePersonal(reading, projects, members)) {
      const id = lineId(line);
      if (seenLines.has(id)) continue;
      seenLines.add(id);
      lines.push(line);
    }
  }
  return { lines, mirrorAuthors };
}
