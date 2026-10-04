import { CANVAS_SHARE_CELLS } from '../config/constants.ts';
import type { CanvasParagraph } from './canvas-message.ts';

/** Строка доли, когда процента нет. */
export const NO_DATA_SHARE = 'Нет данных';

/** Целых процентов в единице доли. */
const PERCENT_SCALE = 100;

const SHARE_CELL_FILLED = '█';
const SHARE_CELL_EMPTY = '░';

/** Полоска доли. Клетка закрашена, только если процент покрывает её целиком. */
export function shareBar(percent: number | null): string {
  const filled = percent === null || percent <= 0 ? 0 : percent >= PERCENT_SCALE ? CANVAS_SHARE_CELLS : Math.floor((percent * CANVAS_SHARE_CELLS) / PERCENT_SCALE);
  return SHARE_CELL_FILLED.repeat(filled) + SHARE_CELL_EMPTY.repeat(CANVAS_SHARE_CELLS - filled);
}

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
  return [{ pieces: [{ kind: 'text', text: `${shareBar(null)} ${NO_DATA_SHARE}` }] }];
}

/**
 * Полоска, затем «N% · осталось X из Y». Слов «Сделано по проекту» нет: их место занимает полоска.
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
          text: `${shareBar(percent)} ${String(percent)}% · осталось ${String(share.remaining)} из ${String(total)}`,
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
