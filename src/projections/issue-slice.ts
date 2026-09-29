import { CANVAS_SLICE_SIZE } from '../config/constants.ts';
import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-5. Срез issues на канвасе: «Сделано», «В работе», «Далее».
 * Пункт — `#номер название`. В «В работе» после названия — «— имя».
 * Каждая часть короче полного списка: не длиннее `CANVAS_SLICE_SIZE`.
 * Какие issues в какую часть и чьё имя — решает домен.
 * Связь дописывается к пункту, который уже в списке: `blocked by #N`, `sub-issue #N`.
 */

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_DONE_HEADING = 'Сделано';

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_IN_PROGRESS_HEADING = 'В работе';

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_NEXT_HEADING = 'Далее';

/** Пункт среза: номер и название issue. Связи пустые — пометки нет. */
export interface SliceIssueLine {
  number: number;
  title: string;
  /** Номера issues, которые блокируют этот. */
  blockedBy?: readonly number[];
  /** Номера sub-issues этого issue. */
  subIssues?: readonly number[];
}

/** Пункт «В работе»: к названию дописывается имя, если оно уже есть. */
export interface SliceInProgressLine extends SliceIssueLine {
  assigneeName: string;
}

function issueNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1) throw new Error('номер issue в срезе — целое больше нуля');
  return String(value);
}

function issueTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new Error('у пункта среза есть название');
  return title;
}

function issueHead(issue: SliceIssueLine): string {
  return `#${issueNumber(issue.number)} ${issueTitle(issue.title)}`;
}

function hashNumbers(values: readonly number[] | undefined): string {
  const printed: string[] = [];
  for (const value of values ?? []) printed.push(`#${issueNumber(value)}`);
  return printed.join(', ');
}

/** ` · blocked by #N · sub-issue #N`. Пустые связи ничего не дописывают. */
function linkNote(issue: SliceIssueLine): string {
  const notes: string[] = [];
  const blocked = hashNumbers(issue.blockedBy);
  const subs = hashNumbers(issue.subIssues);
  if (blocked.length > 0) notes.push(`blocked by ${blocked}`);
  if (subs.length > 0) notes.push(`sub-issue ${subs}`);
  if (notes.length === 0) return '';
  return ` · ${notes.join(' · ')}`;
}

/** `#номер название`, и связи, если они есть у этого пункта. */
export function sliceIssueText(issue: SliceIssueLine): string {
  return `${issueHead(issue)}${linkNote(issue)}`;
}

/** `#номер название — имя`, затем связи. Пустое имя тире не рисует. */
export function inProgressSliceText(issue: SliceInProgressLine): string {
  const name = issue.assigneeName.trim();
  const named = name.length === 0 ? issueHead(issue) : `${issueHead(issue)} — ${name}`;
  return `${named}${linkNote(issue)}`;
}

function shortSlice<T>(items: readonly T[]): T[] {
  return items.slice(0, CANVAS_SLICE_SIZE);
}

function withPunctuation(lines: readonly string[]): string[] {
  const printed: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    printed.push(index === lines.length - 1 ? `${line}.` : `${line};`);
  }
  return printed;
}

function section(heading: string, lines: readonly string[]): CanvasParagraph[] {
  if (lines.length === 0) return [];
  const paragraphs: CanvasParagraph[] = [{ pieces: [{ kind: 'text', text: heading }] }];
  for (const line of withPunctuation(lines)) {
    paragraphs.push({ pieces: [{ kind: 'text', text: line }] });
  }
  return paragraphs;
}

/** «Сделано»: заголовок и короткий список. Пустой список не печатается. */
export function doneSliceParagraphs(issues: readonly SliceIssueLine[]): CanvasParagraph[] {
  return section(
    SLICE_DONE_HEADING,
    shortSlice(issues).map((issue) => sliceIssueText(issue)),
  );
}

/** «В работе»: заголовок и короткий список с именем. Пустой список не печатается. */
export function inProgressSliceParagraphs(issues: readonly SliceInProgressLine[]): CanvasParagraph[] {
  return section(
    SLICE_IN_PROGRESS_HEADING,
    shortSlice(issues).map((issue) => inProgressSliceText(issue)),
  );
}

/** «Далее»: заголовок и короткий список. Пустой список не печатается. */
export function nextSliceParagraphs(issues: readonly SliceIssueLine[]): CanvasParagraph[] {
  return section(
    SLICE_NEXT_HEADING,
    shortSlice(issues).map((issue) => sliceIssueText(issue)),
  );
}
