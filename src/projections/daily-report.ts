import { REPORT_NEXT_TASKS } from '../config/constants.ts';
import {
  REPORT_BACKLOG_GAP,
  reportProjectBacklogLines,
  reportShareChange,
  type ReportBacklogRemainder,
  type ReportBacklogShare,
  type ReportProjectBacklogView,
} from './report-backlog-block.ts';
import { reportDivergenceLines } from './report-divergence-line.ts';
import { reportGithubBlock, type ReportGithubCi } from './report-github-block.ts';
import { reportTasksLine, type ReportTaskCounters } from './report-tasks-line.ts';
import {
  reportWorkLines,
  type ReportNextLineTask,
  type ReportNowLineTask,
  type ReportRiskView,
} from './report-work-lines.ts';

/**
 * P-12. Ежедневный отчёт: шапка «За сутки · дата», строка «Все проекты»,
 * затем блок на каждый проект адресата.
 * В личке — проекты этого человека и блоки их репозиториев.
 * В командный топик одним текстом — все проекты этого чата.
 * Топики исполнителей адресом отчёта не становятся.
 * «Сейчас» и «Дальше» в личке — задачи этого человека, в командном топике — всех участников.
 * Доля «Все проекты» приходит посчитанной. Проекция её не усредняет и не заменяет нулём.
 * Коммиты и PR в эту долю не входят и по проектам не складываются.
 * Блок GitHub — один на репозиторий: CI, число смерженных PR, число коммитов, имена проектов.
 * Закрытые issues и список коммитов в него не копируются.
 */

/** Куда уходит один текст отчёта. Топик исполнителя сюда не входит. */
export const DAILY_REPORT_DM = 'dm';

export const DAILY_REPORT_TEAM = 'team';

export type DailyReportAudience = typeof DAILY_REPORT_DM | typeof DAILY_REPORT_TEAM;

/** Первая строка макета суток. */
export const DAILY_REPORT_HEADING = 'За сутки';

/** Подпись общей доли. В личке и в командном топике одно и то же слово. */
export const ALL_PROJECTS_LABEL = 'Все проекты';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Репозиторий в составе отчёта.
 * Счётчики — числа самого репозитория, не сумма по проектам.
 * `closedIssueTitles` в блок не копируются: они остаются в «Бэклоге».
 */
export interface ReportRepositoryFacts {
  repositoryId: string;
  slug: string;
  ci: ReportGithubCi;
  commits: number;
  mergedPullRequests: number;
  closedIssueTitles: readonly string[];
}

/**
 * Проект внутри отчёта.
 * `chatId` — группа, чей это проект. Чужой чат в текст не входит.
 * `memberIds` — кто видит его в личке. В командном топике блок печатается всё равно.
 * `now` и `next` — задачи всех участников. Кому их печатать, решает адресат.
 */
export interface DailyReportProject {
  chatId: string;
  memberIds: readonly string[];
  backlog: ReportProjectBacklogView;
  tasks: ReportTaskCounters;
  now: readonly (ReportNowLineTask & { assigneeId: string })[];
  next: readonly (ReportNextLineTask & { assigneeId: string })[];
  risk: ReportRiskView;
  divergence: boolean;
  repository: ReportRepositoryFacts | null;
}

/**
 * Факты одного ежедневного отчёта.
 * `date` — календарный день `YYYY-MM-DD`, в тексте `ДД.ММ`.
 * Доля «Все проекты» — на начало и конец, остаток на конец.
 */
export interface DailyReportView {
  chatId: string;
  date: string;
  audience: DailyReportAudience;
  /** Адресат лички. В командном топике не читается. */
  memberId: string | null;
  shareAtStart: ReportBacklogShare;
  shareAtEnd: ReportBacklogShare;
  remainderAtEnd: ReportBacklogRemainder | null;
  projects: readonly DailyReportProject[];
}

function audienceOf(value: string): DailyReportAudience {
  if (value === DAILY_REPORT_DM || value === DAILY_REPORT_TEAM) return value;
  throw new Error('отчёт за сутки — личка или командный топик');
}

function memberOf(value: string | null): string {
  if (value === null) throw new Error('личный отчёт адресован человеку');
  const id = value.trim();
  if (id.length === 0) throw new Error('личный отчёт адресован человеку');
  return id;
}

function memberIdsOf(ids: readonly string[]): string[] {
  return ids.map((value) => {
    const id = value.trim();
    if (id.length === 0) throw new Error('у участника проекта есть id');
    return id;
  });
}

/** Куда человек читает отчёт. Топика исполнителя среди мест нет. */
export interface ReportReading {
  place: DailyReportAudience;
  memberId: string | null;
  threadId: number | null;
}

function chatIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new Error('у отчёта есть чат');
  return id;
}

function assigneeIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new Error('у задачи отчёта есть исполнитель');
  return id;
}

function threadIdOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('номер топика — целое больше нуля');
  return value;
}

function workFor<T extends { assigneeId: string }>(
  tasks: readonly T[],
  audience: DailyReportAudience,
  memberId: string | null,
): T[] {
  const scoped: T[] = [];
  for (const task of tasks) {
    const assigneeId = assigneeIdOf(task.assigneeId);
    if (audience === DAILY_REPORT_TEAM || assigneeId === memberId) scoped.push(task);
  }
  return scoped;
}

function repositoryAgrees(left: ReportRepositoryFacts, right: ReportRepositoryFacts): boolean {
  return (
    left.slug === right.slug &&
    left.ci === right.ci &&
    left.commits === right.commits &&
    left.mergedPullRequests === right.mergedPullRequests
  );
}

/**
 * Блоки GitHub выбранных проектов.
 * Один репозиторий — один блок, имена проектов собираются в него.
 * Повтор тех же чисел не складывается во вторую копию и не суммируется.
 * Названия закрытых issues в текст не попадают.
 */
function repositoryParagraphs(projects: readonly DailyReportProject[]): string[] {
  const groups: { repo: ReportRepositoryFacts; names: string[] }[] = [];
  const indexById = new Map<string, number>();
  for (const project of projects) {
    const repo = project.repository;
    if (repo === null) continue;
    const id = repo.repositoryId.trim();
    if (id.length === 0) throw new Error('у блока репозитория есть имя');
    for (const title of repo.closedIssueTitles) {
      if (title.trim().length === 0) throw new Error('у закрытого issue есть название');
    }
    const name = project.backlog.projectName.trim();
    if (name.length === 0) throw new Error('у блока проекта есть имя');
    const index = indexById.get(id);
    if (index === undefined) {
      indexById.set(id, groups.length);
      groups.push({ repo, names: [name] });
      continue;
    }
    const previous = groups[index];
    if (previous === undefined || !repositoryAgrees(previous.repo, repo)) {
      throw new Error('коммиты и PR репозитория по проектам не складываются');
    }
    previous.names.push(name);
  }
  return groups.map((group) =>
    reportGithubBlock({
      slug: group.repo.slug,
      ci: group.repo.ci,
      mergedPullRequests: group.repo.mergedPullRequests,
      commits: group.repo.commits,
      projectNames: group.names,
    }),
  );
}

function dayMonth(iso: string): string {
  const match = CALENDAR_DATE.exec(iso.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('дата отчёта — календарный день');
  return `${day}.${month}`;
}

function projectBlock(
  project: DailyReportProject,
  showAssignee: boolean,
  audience: DailyReportAudience,
  memberId: string | null,
): string {
  const lines = [
    ...reportProjectBacklogLines(project.backlog),
    reportTasksLine(project.tasks),
    ...reportWorkLines({
      now: workFor(project.now, audience, memberId),
      next: workFor(project.next, audience, memberId).slice(0, REPORT_NEXT_TASKS),
      reasons: project.risk.reasons,
      defaultBranchCiRed: project.risk.defaultBranchCiRed,
      pullRequests: project.risk.pullRequests,
      showAssignee,
    }),
    ...reportDivergenceLines(project.divergence),
  ];
  return lines.join('\n');
}

/**
 * Один текст отчёта за сутки.
 * Сначала «За сутки · ДД.ММ», затем «Все проекты», когда доля есть.
 * Дальше блок каждого проекта этого чата и один блок на каждый его репозиторий.
 * В личке нет чужих проектов и чужих задач «Сейчас» и «Дальше».
 * Пустая общая доля строку не занимает.
 */
export function dailyReport(view: DailyReportView): string {
  const audience = audienceOf(view.audience);
  const chatId = chatIdOf(view.chatId);
  const showAssignee = audience === DAILY_REPORT_TEAM;
  const memberId = audience === DAILY_REPORT_DM ? memberOf(view.memberId) : null;
  const projects = view.projects.map((project) => ({
    project,
    chatId: chatIdOf(project.chatId),
    memberIds: memberIdsOf(project.memberIds),
  }));
  for (const item of projects) {
    for (const task of [...item.project.now, ...item.project.next]) assigneeIdOf(task.assigneeId);
  }
  const inChat = projects.filter((item) => item.chatId === chatId);
  const chosen = memberId === null ? inChat : inChat.filter((item) => item.memberIds.includes(memberId));
  const blocks = chosen.map((item) => projectBlock(item.project, showAssignee, audience, memberId));
  const head = [`${DAILY_REPORT_HEADING}${REPORT_BACKLOG_GAP}${dayMonth(view.date)}`];
  const change = reportShareChange(view.shareAtStart, view.shareAtEnd, view.remainderAtEnd);
  if (change !== null) head.push(`${ALL_PROJECTS_LABEL}: ${change}`);
  return [head.join('\n'), ...blocks, ...repositoryParagraphs(chosen.map((item) => item.project))].join('\n\n');
}

/**
 * Два места чтения: личка каждого участника и один командный топик.
 * Топики исполнителей в список не входят. На несколько проектов чата командный адрес один.
 */
export function reportReadings(input: {
  memberIds: readonly string[];
  commandTopicId: number;
  executorTopicIds: readonly number[];
}): readonly ReportReading[] {
  const commandTopicId = threadIdOf(input.commandTopicId);
  const executorTopicIds = input.executorTopicIds.map(threadIdOf);
  if (executorTopicIds.includes(commandTopicId)) {
    throw new Error('топик исполнителя отчёт не получает');
  }
  const members: string[] = [];
  const seen = new Set<string>();
  for (const value of input.memberIds) {
    const id = value.trim();
    if (id.length === 0) throw new Error('у участника проекта есть id');
    if (seen.has(id)) continue;
    seen.add(id);
    members.push(id);
  }
  const readings: ReportReading[] = [
    { place: DAILY_REPORT_TEAM, memberId: null, threadId: commandTopicId },
    ...members.map((memberId): ReportReading => ({ place: DAILY_REPORT_DM, memberId, threadId: null })),
  ];
  for (const reading of readings) {
    if (reading.threadId !== null && executorTopicIds.includes(reading.threadId)) {
      throw new Error('топик исполнителя отчёт не получает');
    }
  }
  return readings;
}
