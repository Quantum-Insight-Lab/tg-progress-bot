import { STALE_DAYS } from '../../config/constants.ts';
import { DOMAIN_ERROR, DomainError } from './errors.ts';

/**
 * Сутки проекта — календарная дата в его таймзоне (INV-24).
 * Длина суток здесь — шаг календаря, не порог продукта: порог застоя — `STALE_DAYS`.
 */
function millisecondsInDay(): number {
  return Date.UTC(0, 0, 1 + 1) - Date.UTC(0, 0, 1);
}

function parts(instant: Date, timezone: string): { year: number; month: number; day: number } {
  let bag: Intl.DateTimeFormatPart[];
  try {
    bag = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
  } catch (error) {
    if (error instanceof RangeError) throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'таймзона не распознана');
    throw error;
  }
  const year = bag.find((part) => part.type === 'year')?.value;
  const month = bag.find((part) => part.type === 'month')?.value;
  const day = bag.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'таймзона не распознана');
  }
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/** Календарный день момента в таймзоне проекта, `YYYY-MM-DD`. */
export function projectCalendarDate(instant: Date, timezone: string): string {
  const zone = timezone.trim();
  if (zone.length === 0) throw new DomainError(DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK, 'У проекта есть таймзона');
  const { year, month, day } = parts(instant, zone);
  const monthText = String(month).padStart(1 + 1, '0');
  const dayText = String(day).padStart(1 + 1, '0');
  return `${String(year)}-${monthText}-${dayText}`;
}

/** Сколько календарных суток проекта между двумя моментами. Отрицательное — второй момент раньше. */
export function projectDaysBetween(earlier: Date, later: Date, timezone: string): number {
  const zone = timezone.trim();
  const from = parts(earlier, zone);
  const to = parts(later, zone);
  const start = Date.UTC(from.year, from.month - 1, from.day);
  const end = Date.UTC(to.year, to.month - 1, to.day);
  return (end - start) / millisecondsInDay();
}

/**
 * Застой считается по таймзоне проекта: календарных суток без отметки не меньше `STALE_DAYS`.
 * Смена зоны меняет этот счёт, не переписывая уже отправленный канвас.
 */
export function staleByProjectZone(lastMark: Date, now: Date, timezone: string): boolean {
  return projectDaysBetween(lastMark, now, timezone) >= STALE_DAYS;
}
