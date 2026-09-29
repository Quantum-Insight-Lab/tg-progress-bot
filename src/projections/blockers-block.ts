import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-8. Блок «Блокеры» на канвасе.
 * Причина задачи — когда ответ уже есть. Строки CI и PR идут отдельно и номер задачи не называют.
 * Красный CI основной ветки — свой абзац. Пустой блок строку не занимает.
 */

/** Заголовок блока. Пустой список абзац не занимает. */
export const BLOCKERS_BLOCK_HEADING = 'Блокеры';

/** Красный CI основной git-ветки. Номера задачи в строке нет. */
export const BLOCKER_DEFAULT_BRANCH_CI = 'CI основной ветки красный';

/** Причина задачи в `BLOCKED`. Пустая причина на канвас не попадает. */
export interface BlockerReasonInput {
  taskNumber: number;
  reason: string | null;
}

/** Его застоявшийся PR. Красный CI — пометка этой же строки. */
export interface BlockerPullRequestInput {
  pullRequestNumber: number;
  ciRed: boolean;
}

/** Что блок печатает. Отбор строк — до печати. */
export interface BlockersBlock {
  reasons: readonly BlockerReasonInput[];
  pullRequests: readonly BlockerPullRequestInput[];
  defaultBranchCiRed: boolean;
}

function positive(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} — целое число`);
  return value;
}

/** Строка причины. Пока ответа нет — строки нет. */
export function blockerReasonText(line: BlockerReasonInput): string | null {
  if (line.reason === null) return null;
  const reason = line.reason.trim();
  if (reason.length === 0) return null;
  return `${String(positive(line.taskNumber, 'номер задачи'))} — ${reason}`;
}

/** «PR #N без движения». Красный CI дописывается к той же строке. */
export function blockerPullRequestText(line: BlockerPullRequestInput): string {
  const number = positive(line.pullRequestNumber, 'номер pull request');
  const text = `PR #${String(number)} без движения`;
  if (!line.ciRed) return text;
  return `${text}, CI красный`;
}

/**
 * Блок «Блокеры»: заголовок, причины, красный CI основной ветки и его PR.
 * Причины без ответа не печатаются. Нет ни одной строки — блока нет.
 */
export function blockersBlockParagraphs(block: BlockersBlock): CanvasParagraph[] {
  const lines: string[] = [];
  for (const reason of block.reasons) {
    const text = blockerReasonText(reason);
    if (text !== null) lines.push(text);
  }
  if (block.defaultBranchCiRed) lines.push(BLOCKER_DEFAULT_BRANCH_CI);
  for (const pullRequest of block.pullRequests) lines.push(blockerPullRequestText(pullRequest));
  if (lines.length === 0) return [];
  const paragraphs: CanvasParagraph[] = [{ pieces: [{ kind: 'text', text: BLOCKERS_BLOCK_HEADING }] }];
  for (const text of lines) paragraphs.push({ pieces: [{ kind: 'text', text }] });
  return paragraphs;
}
