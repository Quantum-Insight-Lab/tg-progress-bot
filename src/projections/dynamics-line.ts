import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-11. Строка динамики на канвасе: последние снимки доли одной строкой.
 * Точки уже отобраны с шагом недели. Пропущенного снимка в списке нет.
 * Пустая доля печатается как «Нет данных», не как ноль.
 */

/** Пустая доля точки. Это не 0%. */
export const DYNAMICS_NO_DATA = 'Нет данных';

/** Целых процентов в единице доли. */
const PERCENT_SCALE = 100;

/** Точка строки. Пустая доля — снимок без числа. */
export interface DynamicsPoint {
  date: string;
  progress: number | null;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayMonth(iso: string): string {
  const match = CALENDAR_DATE.exec(iso.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('дата точки динамики — календарный день');
  return `${day}.${month}`;
}

function percentText(progress: number): string {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('доля точки динамики — число от нуля до единицы или пусто');
  }
  const percent = Math.round(progress * PERCENT_SCALE);
  return `${String(percent)}%`;
}

function pointText(point: DynamicsPoint): string {
  const value = point.progress === null ? DYNAMICS_NO_DATA : percentText(point.progress);
  return `${dayMonth(point.date)} — ${value}`;
}

/** Одна строка точек через « · ». Пустой список абзац не занимает. */
export function dynamicsLineText(points: readonly DynamicsPoint[]): string | null {
  if (points.length === 0) return null;
  return points.map(pointText).join(' · ');
}

/** Один абзац канваса. Снимков на даты выборки нет — строки нет. */
export function dynamicsLineParagraphs(points: readonly DynamicsPoint[]): CanvasParagraph[] {
  const text = dynamicsLineText(points);
  if (text === null) return [];
  return [{ pieces: [{ kind: 'text', text }] }];
}
