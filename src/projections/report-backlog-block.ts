import { REPORT_LIST_LIMIT } from '../config/constants.ts';

/**
 * P-13. Строки бэклога в блоке проекта отчёта.
 * Имя проекта, «Бэклог: было → стало · осталось», «Закрыто», «Открыто новых».
 * Числа и списки приходят из фактов периода. Проекция их не пересчитывает.
 * Пустой процент не заменяется нулём: нет доли — строки «Бэклог» нет.
 * «Нет данных» вместо пустой строки не печатается.
 * «Закрыто» длиннее `REPORT_LIST_LIMIT` — число и до этого лимита названий.
 * Дата подтверждения задачи остаётся в отчёте календарным днём, даже когда
 * сама задача с канваса уже ушла.
 */

/** Подпись строки доли. Другого слова у блока нет. */
export const REPORT_BACKLOG_LABEL = 'Бэклог';

/** Подпись строки закрытых issues. */
export const REPORT_CLOSED_LABEL = 'Закрыто';

/** Подпись строки новых открытых issues. Печатается число, не названия. */
export const REPORT_OPENED_LABEL = 'Открыто новых';

/** Промежуток между процентом и остатком, как в макете отчёта. */
export const REPORT_BACKLOG_GAP = ' · ';

/** Целых процентов в единице доли. Округление — как у строки канваса. */
const PERCENT_SCALE = 100;

/** Стрелка «было → стало» в макете суток. */
const SHARE_ARROW = ' → ';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Доля на одну границу периода.
 * `ratio === null` — числа нет. Это не ноль.
 */
export interface ReportBacklogShare {
  completed: number;
  remaining: number;
  ratio: number | null;
}

/** Остаток на конец периода: открытые и все, что входит в знаменатель. */
export interface ReportBacklogRemainder {
  remaining: number;
  total: number;
}

/** Issue в строке «Закрыто» или в счётчике «Открыто новых». */
export interface ReportBacklogIssue {
  number: number;
  title: string;
}

/**
 * Блок проекта: имя и факты бэклога за период.
 * `confirmedOn` — календарные дни подтверждения задач, `YYYY-MM-DD`.
 */
export interface ReportProjectBacklogView {
  projectName: string;
  shareAtStart: ReportBacklogShare;
  shareAtEnd: ReportBacklogShare;
  remainderAtEnd: ReportBacklogRemainder | null;
  closed: readonly ReportBacklogIssue[];
  openedNew: readonly ReportBacklogIssue[];
  confirmedOn: readonly string[];
}

function projectTitle(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new Error('у блока проекта есть имя');
  return name;
}

function count(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(message);
  return value;
}

function shareKnown(share: ReportBacklogShare): boolean {
  if (share.ratio === null) return false;
  if (!Number.isFinite(share.ratio) || share.ratio < 0 || share.ratio > 1) {
    throw new Error('доля бэклога отчёта — число от нуля до единицы или пусто');
  }
  count(share.completed, 'счётчик доли отчёта — целое от нуля');
  count(share.remaining, 'счётчик доли отчёта — целое от нуля');
  if (share.completed + share.remaining < 1) throw new Error('у известной доли отчёта есть issues');
  return true;
}

function percentText(share: ReportBacklogShare): string {
  const completed = count(share.completed, 'счётчик доли отчёта — целое от нуля');
  const remaining = count(share.remaining, 'счётчик доли отчёта — целое от нуля');
  const total = completed + remaining;
  const percent = Math.round((completed * PERCENT_SCALE) / total);
  return `${String(percent)}%`;
}

function remainderText(remainder: ReportBacklogRemainder): string {
  const remaining = count(remainder.remaining, 'остаток отчёта — целое от нуля');
  const total = count(remainder.total, 'остаток отчёта — целое от нуля');
  if (total < 1 || remaining > total) throw new Error('остаток отчёта — открытые из общего числа');
  return `осталось ${String(remaining)} из ${String(total)}`;
}

function issueName(issue: ReportBacklogIssue): string {
  if (!Number.isInteger(issue.number) || issue.number < 1) {
    throw new Error('номер issue в отчёте — целое больше нуля');
  }
  const title = issue.title.trim();
  if (title.length === 0) throw new Error('у issue отчёта есть название');
  return `#${String(issue.number)} ${title}`;
}

function dayMonth(iso: string): string {
  const match = CALENDAR_DATE.exec(iso.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('дата подтверждения — календарный день');
  return `${day}.${month}`;
}

function confirmationDates(days: readonly string[]): string | null {
  const seen = new Set<string>();
  const printed: string[] = [];
  for (const day of days) {
    const text = dayMonth(day);
    if (seen.has(text)) continue;
    seen.add(text);
    printed.push(text);
  }
  if (printed.length === 0) return null;
  return printed.join(REPORT_BACKLOG_GAP);
}

/** Связка числа и названий, когда закрытых больше лимита. Как в макете недели. */
const CLOSED_AMONG = ', среди них ';

/**
 * «Закрыто»: все названия, пока их не больше лимита.
 * Длиннее — число и первые названия, не длиннее `REPORT_LIST_LIMIT`.
 * Пустой список строку не занимает.
 */
function closedLine(issues: readonly ReportBacklogIssue[]): string | null {
  if (issues.length === 0) return null;
  const names = issues.map(issueName);
  if (names.length <= REPORT_LIST_LIMIT) return `${REPORT_CLOSED_LABEL}: ${names.join(', ')}`;
  const shown = names.slice(0, REPORT_LIST_LIMIT).join(', ');
  return `${REPORT_CLOSED_LABEL}: ${String(names.length)}${CLOSED_AMONG}${shown}`;
}

/**
 * Строки бэклога одного проекта.
 * «Бэклог» — только когда доля есть на обеих границах и остаток есть на конец.
 * «Закрыто» — названия issues, не длиннее лимита. «Открыто новых» — сколько таких issues, без названий.
 * Пустые списки строку не занимают. Дата подтверждения дописывается днём `ДД.ММ`.
 * Нет доли — строки нет, слова «Нет данных» нет.
 */
export function reportProjectBacklogLines(view: ReportProjectBacklogView): readonly string[] {
  const lines: string[] = [projectTitle(view.projectName)];
  const startKnown = shareKnown(view.shareAtStart);
  const endKnown = shareKnown(view.shareAtEnd);
  if (startKnown && endKnown && view.remainderAtEnd !== null) {
    lines.push(
      `${REPORT_BACKLOG_LABEL}: ${percentText(view.shareAtStart)}${SHARE_ARROW}${percentText(view.shareAtEnd)}${REPORT_BACKLOG_GAP}${remainderText(view.remainderAtEnd)}`,
    );
  }
  const closed = closedLine(view.closed);
  if (closed !== null) lines.push(closed);
  if (view.openedNew.length > 0) {
    for (const issue of view.openedNew) issueName(issue);
    lines.push(`${REPORT_OPENED_LABEL}: ${String(view.openedNew.length)}`);
  }
  const confirmed = confirmationDates(view.confirmedOn);
  if (confirmed !== null) lines.push(confirmed);
  return lines;
}
