import { CANVAS_SLICE_SIZE } from '../config/constants.ts';
import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-5. Срез issues на канвасе: «Сделано», «В работе», «Далее».
 * Пункт — `#номер название`. В «В работе» после названия — «— имя».
 * Каждая часть короче полного списка: не длиннее `CANVAS_SLICE_SIZE`.
 * Какие issues в какую часть, имя по логину и связи к пункту сюда не входят.
 */

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_DONE_HEADING = 'Сделано';

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_IN_PROGRESS_HEADING = 'В работе';

/** Заголовок блока. Пустой список абзац не занимает. */
export const SLICE_NEXT_HEADING = 'Далее';

/** Пункт среза: номер и название issue. */
export interface SliceIssueLine {
  number: number;
  title: string;
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

/** `#номер название`. */
export function sliceIssueText(issue: SliceIssueLine): string {
  return `#${issueNumber(issue.number)} ${issueTitle(issue.title)}`;
}

/** `#номер название — имя`. Пустое имя тире не рисует. */
export function inProgressSliceText(issue: SliceInProgressLine): string {
  const line = sliceIssueText(issue);
  const name = issue.assigneeName.trim();
  if (name.length === 0) return line;
  return `${line} — ${name}`;
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
