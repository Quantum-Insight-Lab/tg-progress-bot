import { BLOCKER_DEFAULT_BRANCH_CI, blockerPullRequestText } from './blockers-block.ts';
import { taskDayMark } from './tasks-block.ts';

/**
 * P-13. Строки «Сейчас», «Дальше» и «Риск» в блоке проекта отчёта.
 * Состав приходит из фактов. Проекция его не пересчитывает.
 * Имя исполнителя — только когда строка идёт в командный топик.
 * Пустой набор строку не занимает: нет задач «Сейчас» — строки «Сейчас» нет.
 * Число issues без коммитов, без PR и без свежих комментариев в эти строки не входит.
 */

/** Подпись строки текущих задач. */
export const REPORT_NOW_LABEL = 'Сейчас';

/** Подпись строки плана. */
export const REPORT_NEXT_LABEL = 'Дальше';

/** Подпись строки риска. */
export const REPORT_RISK_LABEL = 'Риск';

/** Задача «Сейчас». День и имя уже посчитаны. */
export interface ReportNowLineTask {
  number: number;
  title: string;
  day: number;
  assigneeName: string | null;
}

/** Задача «Дальше». День и имя на эту строку не попадают. */
export interface ReportNextLineTask {
  number: number;
  title: string;
}

/** Причина и факты застоя. Текст причины уже дословный. */
export interface ReportRiskView {
  reasons: readonly { text: string }[];
  defaultBranchCiRed: boolean;
  pullRequests: readonly { pullRequestNumber: number; ciRed: boolean }[];
}

function positive(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} — целое больше нуля`);
  return value;
}

function titleOf(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new Error('у строки отчёта есть название');
  return title;
}

/**
 * «Сейчас: N — название — имя, K-й день».
 * Без имени: «Сейчас: N — название, K-й день».
 */
export function reportNowLine(task: ReportNowLineTask, showAssignee: boolean): string {
  const number = positive(task.number, 'номер задачи отчёта');
  const title = titleOf(task.title);
  const day = taskDayMark(positive(task.day, 'день задачи отчёта'));
  const head = `${REPORT_NOW_LABEL}: ${String(number)} — ${title}`;
  const name = showAssignee && task.assigneeName !== null ? task.assigneeName.trim() : '';
  if (name.length > 0) return `${head} — ${name}, ${day}`;
  return `${head}, ${day}`;
}

/** «Сейчас» по задаче на строку. Пустой список строку не занимает. */
export function reportNowLines(tasks: readonly ReportNowLineTask[], showAssignee: boolean): string[] {
  return tasks.map((task) => reportNowLine(task, showAssignee));
}

/** «Дальше: N — название». */
export function reportNextLine(task: ReportNextLineTask): string {
  const number = positive(task.number, 'номер задачи отчёта');
  return `${REPORT_NEXT_LABEL}: ${String(number)} — ${titleOf(task.title)}`;
}

/** «Дальше» по задаче на строку. Пустой список строку не занимает. */
export function reportNextLines(tasks: readonly ReportNextLineTask[]): string[] {
  return tasks.map((task) => reportNextLine(task));
}

/**
 * «Риск: …» — причина блокера и факты застоя дословно.
 * Красный CI и PR берут те же формулировки, что блок «Блокеры».
 * Пустая причина строку не занимает. Номер задачи к тексту не приписывается.
 */
export function reportRiskLines(view: ReportRiskView): string[] {
  const lines: string[] = [];
  for (const reason of view.reasons) {
    const text = reason.text.trim();
    if (text.length === 0) continue;
    lines.push(`${REPORT_RISK_LABEL}: ${text}`);
  }
  if (view.defaultBranchCiRed) lines.push(`${REPORT_RISK_LABEL}: ${BLOCKER_DEFAULT_BRANCH_CI}`);
  for (const pullRequest of view.pullRequests) {
    lines.push(`${REPORT_RISK_LABEL}: ${blockerPullRequestText(pullRequest)}`);
  }
  return lines;
}

/**
 * Три строки блока в порядке макета: «Сейчас», «Дальше», «Риск».
 * Которой нет в фактах — той нет в тексте.
 */
export function reportWorkLines(
  view: ReportRiskView & {
    now: readonly ReportNowLineTask[];
    next: readonly ReportNextLineTask[];
    showAssignee: boolean;
  },
): string[] {
  return [
    ...reportNowLines(view.now, view.showAssignee),
    ...reportNextLines(view.next),
    ...reportRiskLines(view),
  ];
}
