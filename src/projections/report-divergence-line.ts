import { DIVERGENCE_LINE } from './divergence-line.ts';

/**
 * P-13. Строка расхождения в блоке проекта отчёта.
 * Печатается, когда для этого проекта уже выполнено условие сигнала.
 * Пока сигнала нет — строки нет. «Нет данных» вместо неё не пишется.
 * Статусы и блокеры эта строка не меняет.
 */

/** Одна строка текста сигнала. Пока он молчит — пусто. */
export function reportDivergenceLines(active: boolean): readonly string[] {
  if (!active) return [];
  return [DIVERGENCE_LINE];
}
