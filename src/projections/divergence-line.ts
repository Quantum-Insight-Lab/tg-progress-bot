import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-10. Строка расхождения на канвасе, под строкой GitHub.
 * Печатается, когда сигнал за закрытые сутки перед датой канваса горит.
 * Статусы и блокеры эта строка не меняет.
 */

/** Текст сигнала. Другой формулировки у строки нет. */
export const DIVERGENCE_LINE = 'В репозитории есть движение, в задачах за сутки тишина';

/** Один абзац, если сигнал горит. Пока он молчит — строки нет. */
export function divergenceLineParagraphs(active: boolean): CanvasParagraph[] {
  if (!active) return [];
  return [{ pieces: [{ kind: 'text', text: DIVERGENCE_LINE }] }];
}
