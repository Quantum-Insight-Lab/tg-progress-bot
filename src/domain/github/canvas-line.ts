import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { calendarDaysBetween, projectCalendarDate } from '../shared/project-time.ts';
import { type CiStatus } from './ci-status.ts';
import { MILESTONE_STATE_OPEN, milestoneDueOn } from './milestone.ts';
import { PULL_REQUEST_STATE_OPEN } from './pull-request.ts';

/**
 * Строка GitHub канваса (P-9).
 * Считается на лету из зеркала репозитория: CI основной ветки, открытые PR,
 * коммиты календарных суток проекта и ближайший открытый milestone со сроком.
 * Задачи и блокеры это чтение не меняет. Ветки и метки в строку не входят.
 */

/** Milestone, который печатается: открытый, со сроком. */
export interface GithubCanvasMilestoneLine {
  title: string;
  /** Календарная дата `YYYY-MM-DD`. */
  dueOn: string;
}

/** Факты одной строки. Пустой `ci` — статус основной ветки ещё неизвестен. */
export interface GithubCanvasLine {
  owner: string;
  name: string;
  ci: CiStatus | null;
  openPullRequests: number;
  commitsOnDay: number;
  milestone: GithubCanvasMilestoneLine | null;
}

/** Pull request зеркала. В счёт идёт только открытый, название в строку не входит. */
export interface GithubCanvasPullRequest {
  state: string;
}

/** Коммит хвоста. В сутки проекта попадает по `createdAt`. */
export interface GithubCanvasCommit {
  createdAt: Date;
}

/** Milestone зеркала. Закрытый и без срока в строку не берётся. */
export interface GithubCanvasMilestone {
  milestoneNumber: number;
  title: string;
  state: string;
  dueOn: string | null;
}

function countOpenPullRequests(pullRequests: readonly GithubCanvasPullRequest[]): number {
  let count = 0;
  for (const pullRequest of pullRequests) {
    if (pullRequest.state === PULL_REQUEST_STATE_OPEN) count += 1;
  }
  return count;
}

function countCommitsOnDay(commits: readonly GithubCanvasCommit[], canvasDate: string, timezone: string): number {
  let count = 0;
  for (const commit of commits) {
    if (projectCalendarDate(commit.createdAt, timezone) === canvasDate) count += 1;
  }
  return count;
}

function nearestOpenMilestone(milestones: readonly GithubCanvasMilestone[]): GithubCanvasMilestoneLine | null {
  let nearest: { title: string; dueOn: string; milestoneNumber: number } | null = null;
  for (const milestone of milestones) {
    if (milestone.state !== MILESTONE_STATE_OPEN) continue;
    const dueOn = milestoneDueOn(milestone.dueOn);
    if (dueOn === null) continue;
    const title = milestone.title.trim();
    if (title.length === 0) {
      throw new DomainError(DOMAIN_ERROR.MILESTONE_TITLE_BLANK, 'У milestone есть название');
    }
    if (
      nearest === null ||
      dueOn < nearest.dueOn ||
      (dueOn === nearest.dueOn && milestone.milestoneNumber < nearest.milestoneNumber)
    ) {
      nearest = { title, dueOn, milestoneNumber: milestone.milestoneNumber };
    }
  }
  if (nearest === null) return null;
  return { title: nearest.title, dueOn: nearest.dueOn };
}

/**
 * Одна строка репозитория на сутки канваса.
 * Ближайший milestone — открытый с самым ранним сроком; при одном сроке — меньший номер.
 * CI pull request сюда не подставляется: на строке состояние основной ветки.
 */
export function githubCanvasLine(input: {
  owner: string;
  name: string;
  ci: CiStatus | null;
  pullRequests: readonly GithubCanvasPullRequest[];
  commits: readonly GithubCanvasCommit[];
  milestones: readonly GithubCanvasMilestone[];
  canvasDate: string;
  timezone: string;
}): GithubCanvasLine {
  const owner = input.owner.trim();
  const name = input.name.trim();
  if (owner.length === 0) throw new DomainError(DOMAIN_ERROR.REPOSITORY_OWNER_BLANK, 'у репозитория есть owner');
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.REPOSITORY_NAME_BLANK, 'у репозитория есть name');
  calendarDaysBetween(input.canvasDate, input.canvasDate);
  return {
    owner,
    name,
    ci: input.ci,
    openPullRequests: countOpenPullRequests(input.pullRequests),
    commitsOnDay: countCommitsOnDay(input.commits, input.canvasDate, input.timezone),
    milestone: nearestOpenMilestone(input.milestones),
  };
}
