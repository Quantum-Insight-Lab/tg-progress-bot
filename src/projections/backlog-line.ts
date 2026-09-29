import type { CanvasParagraph } from './canvas-message.ts';

/** Строка доли, когда процента нет. */
export const NO_DATA_SHARE = 'Нет данных';

/** Целых процентов в единице доли. */
const PERCENT_SCALE = 100;

/** Доля, которую канвас печатает. Поля те же, что у расчёта бэклога. */
export interface CanvasBacklogShare {
  completed: number;
  remaining: number;
  ratio: number | null;
}

/**
 * Абзац доли на канвасе, когда числа нет.
 * Известная доля сюда не печатается: процент и остаток собирает соседняя проекция.
 */
export function noDataShareParagraphs(ratio: number | null): CanvasParagraph[] {
  if (ratio !== null) return [];
  return [{ pieces: [{ kind: 'text', text: NO_DATA_SHARE }] }];
}

/**
 * «Сделано по проекту: N% · осталось X из Y».
 * Остаток стоит в той же строке, что и процент. Пустая доля сюда не печатается.
 * «из Y» — открытые и completed: `not_planned` в это число не входит.
 */
export function projectShareParagraphs(share: CanvasBacklogShare | null): CanvasParagraph[] {
  if (share === null || share.ratio === null) return [];
  const total = share.completed + share.remaining;
  const percent = Math.round((share.completed * PERCENT_SCALE) / total);
  return [
    {
      pieces: [
        {
          kind: 'text',
          text: `Сделано по проекту: ${String(percent)}% · осталось ${String(share.remaining)} из ${String(total)}`,
        },
      ],
    },
  ];
}

/**
 * Строка доли канваса.
 * Числа нет — «Нет данных». Число есть, в том числе ноль, — процент и остаток.
 */
export function backlogShareParagraphs(share: CanvasBacklogShare | null): CanvasParagraph[] {
  const ratio = share === null ? null : share.ratio;
  return [...noDataShareParagraphs(ratio), ...projectShareParagraphs(share)];
}
