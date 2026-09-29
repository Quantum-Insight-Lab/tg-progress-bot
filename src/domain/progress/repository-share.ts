import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { backlogShare, type BacklogShare } from './backlog-share.ts';

/**
 * Доля бэклога живёт на репозитории.
 * Её читают все проекты, к которым он подключён: линейка — issues всего репозитория,
 * не одного milestone. У milestone отдельного процента нет.
 * Между проектами различается только набор объектов, относящихся к их участникам:
 * этот набор долю не двигает.
 */

/** Строка таблицы `issues`. Проекта и milestone в ней нет. */
export interface IssueRow {
  repositoryId: string;
  issueNumber: number;
  state: string;
  stateReason: string | null;
}

/**
 * Проект в момент чтения. `repositoryId` пуст — репозиторий не подключён.
 * `memberKeys` — какие объекты GitHub относятся к участникам этого проекта.
 */
export interface ProjectMemberSlice {
  projectId: string;
  repositoryId: string | null;
  memberKeys: readonly string[];
}

/** Что проект читает с репозитория. Доля и линейка общие, ключи участников — свои. */
export interface ProjectProgress {
  projectId: string;
  repositoryId: string | null;
  /** Доля репозитория. У проектов с одним id она одна и та же. Без репозитория — пусто. */
  share: BacklogShare | null;
  /** Issues всего репозитория, не срез milestone. */
  lineup: readonly IssueRow[];
  /** Объекты, относящиеся к участникам проекта. В формулу доли не входят. */
  memberKeys: readonly string[];
}

/** Milestone: название и срок. Процента среди полей нет. */
export interface MilestoneFacts {
  repositoryId: string;
  milestoneNumber: number;
  title: string;
  dueOn: string | null;
}

interface RepositoryPicture {
  share: BacklogShare;
  lineup: readonly IssueRow[];
}

function githubId(value: string): string {
  const id = value.trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'id репозитория — id GitHub');
  }
  return id;
}

function projectIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_ID_BLANK, 'У проекта есть id');
  }
  return id;
}

function issueNumberOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'Номер issue — положительное число GitHub');
  }
  return value;
}

function memberKeysOf(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of keys) {
    const key = value.trim();
    if (key.length === 0) {
      throw new DomainError(DOMAIN_ERROR.GITHUB_FACT_KEY, 'У факта GitHub есть ключ внутри репозитория');
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function issueRow(issue: IssueRow): IssueRow {
  return {
    repositoryId: githubId(issue.repositoryId),
    issueNumber: issueNumberOf(issue.issueNumber),
    state: issue.state,
    stateReason: issue.stateReason,
  };
}

function projectRepositoryId(value: string | null): string | null {
  if (value === null) return null;
  const id = value.trim();
  if (id.length === 0) return null;
  return githubId(id);
}

/**
 * Картины репозиториев: одна доля и одна линейка на id.
 * Повтор природного ключа issue в список не входит второй раз — это ошибка.
 */
function pictures(issues: readonly IssueRow[]): Map<string, RepositoryPicture> {
  const seen = new Set<string>();
  const byRepository = new Map<string, IssueRow[]>();
  for (const issue of issues) {
    const row = issueRow(issue);
    const key = `${row.repositoryId}:${String(row.issueNumber)}`;
    if (seen.has(key)) {
      throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'issue репозитория уже есть в списке');
    }
    seen.add(key);
    const list = byRepository.get(row.repositoryId);
    if (list === undefined) byRepository.set(row.repositoryId, [row]);
    else list.push(row);
  }
  const result = new Map<string, RepositoryPicture>();
  for (const [repositoryId, lineup] of byRepository) {
    lineup.sort((left, right) => {
      if (left.issueNumber < right.issueNumber) return -1;
      if (left.issueNumber > right.issueNumber) return 1;
      return 0;
    });
    result.set(repositoryId, { share: backlogShare(lineup), lineup });
  }
  return result;
}

/**
 * Проекты читают долю и линейку своего репозитория.
 * Два проекта с одним репозиторием получают одну долю и одну линейку.
 * Ключи участников остаются при проекте и формулу не меняют.
 * Без репозитория доли нет.
 */
export function projectRepositoryReadings(
  projects: readonly ProjectMemberSlice[],
  issues: readonly IssueRow[],
): ProjectProgress[] {
  const picture = pictures(issues);
  return projects.map((project) => {
    const projectId = projectIdOf(project.projectId);
    const repositoryId = projectRepositoryId(project.repositoryId);
    const memberKeys = memberKeysOf(project.memberKeys);
    if (repositoryId === null) {
      return { projectId, repositoryId: null, share: null, lineup: [], memberKeys };
    }
    let stored = picture.get(repositoryId);
    if (stored === undefined) {
      stored = { share: backlogShare([]), lineup: [] };
      picture.set(repositoryId, stored);
    }
    return {
      projectId,
      repositoryId,
      share: stored.share,
      lineup: stored.lineup,
      memberKeys,
    };
  });
}

/**
 * Отдельного процента у milestone нет.
 * Название и срок на долю бэклога не влияют.
 */
export function milestoneProgress(milestone: MilestoneFacts): null {
  void milestone.repositoryId;
  void milestone.milestoneNumber;
  void milestone.title;
  void milestone.dueOn;
  return null;
}
