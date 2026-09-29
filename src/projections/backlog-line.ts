import type { CanvasParagraph } from './canvas-message.ts';

/** Строка доли, когда процента нет. */
export const NO_DATA_SHARE = 'Нет данных';

/**
 * Абзац доли на канвасе, когда числа нет.
 * Известная доля сюда не печатается: процент и остаток собирает соседняя проекция.
 */
export function noDataShareParagraphs(ratio: number | null): CanvasParagraph[] {
  if (ratio !== null) return [];
  return [{ pieces: [{ kind: 'text', text: NO_DATA_SHARE }] }];
}
