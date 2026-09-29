import {
  REPORT_BACKLOG_GAP,
  reportProjectBacklogLines,
  reportShareChange,
  type ReportBacklogRemainder,
  type ReportBacklogShare,
  type ReportProjectBacklogView,
} from './report-backlog-block.ts';
import { reportDivergenceLines } from './report-divergence-line.ts';
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
 * В личке блоки — проекты этого человека. В командном топике — каждый переданный проект.
 * Доля «Все проекты» приходит посчитанной. Проекция её не усредняет и не заменяет нулём.
 * Блок репозитория сюда не входит.
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
 * Проект внутри отчёта.
 * `memberIds` — кто видит его в личке. В командном топике блок печатается всё равно.
 */
export interface DailyReportProject {
  memberIds: readonly string[];
  backlog: ReportProjectBacklogView;
  tasks: ReportTaskCounters;
  now: readonly ReportNowLineTask[];
  next: readonly ReportNextLineTask[];
  risk: ReportRiskView;
  divergence: boolean;
}

/**
 * Факты одного ежедневного отчёта.
 * `date` — календарный день `YYYY-MM-DD`, в тексте `ДД.ММ`.
 * Доля «Все проекты» — на начало и конец, остаток на конец.
 */
export interface DailyReportView {
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

function dayMonth(iso: string): string {
  const match = CALENDAR_DATE.exec(iso.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('дата отчёта — календарный день');
  return `${day}.${month}`;
}

function projectBlock(project: DailyReportProject, showAssignee: boolean): string {
  const lines = [
    ...reportProjectBacklogLines(project.backlog),
    reportTasksLine(project.tasks),
    ...reportWorkLines({
      now: project.now,
      next: project.next,
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
 * Дальше блок каждого проекта: бэклог, задачи, «Сейчас», «Дальше», «Риск», расхождение.
 * В личке нет проектов других людей. Пустая общая доля строку не занимает.
 */
export function dailyReport(view: DailyReportView): string {
  const audience = audienceOf(view.audience);
  const showAssignee = audience === DAILY_REPORT_TEAM;
  const memberId = audience === DAILY_REPORT_DM ? memberOf(view.memberId) : null;
  const blocks = view.projects.map((project) => ({
    memberIds: memberIdsOf(project.memberIds),
    text: projectBlock(project, showAssignee),
  }));
  const chosen = memberId === null ? blocks : blocks.filter((block) => block.memberIds.includes(memberId));
  const head = [`${DAILY_REPORT_HEADING}${REPORT_BACKLOG_GAP}${dayMonth(view.date)}`];
  const change = reportShareChange(view.shareAtStart, view.shareAtEnd, view.remainderAtEnd);
  if (change !== null) head.push(`${ALL_PROJECTS_LABEL}: ${change}`);
  return [head.join('\n'), ...chosen.map((block) => block.text)].join('\n\n');
}
