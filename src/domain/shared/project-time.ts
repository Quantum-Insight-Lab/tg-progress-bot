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

function clockPart(bag: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = bag.find((part) => part.type === type)?.value;
  if (value === undefined) throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'таймзона не распознана');
  return value;
}

/**
 * Календарный день и местное время `HH:MM` в таймзоне.
 * Час отчёта группы читается отсюда, не из таймзоны проекта и не из часов сервера.
 */
export function projectClock(instant: Date, timezone: string): { date: string; time: string } {
  const zone = timezone.trim();
  if (zone.length === 0) throw new DomainError(DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK, 'У проекта есть таймзона');
  let bag: Intl.DateTimeFormatPart[];
  try {
    bag = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch (error) {
    if (error instanceof RangeError) throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'таймзона не распознана');
    throw error;
  }
  const year = clockPart(bag, 'year');
  const month = clockPart(bag, 'month');
  const day = clockPart(bag, 'day');
  let hour = clockPart(bag, 'hour');
  if (hour === '24') hour = '00';
  const minute = clockPart(bag, 'minute');
  return { date: `${year}-${month}-${day}`, time: `${hour.padStart(1 + 1, '0')}:${minute.padStart(1 + 1, '0')}` };
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcMidnight(isoDate: string): number {
  const match = CALENDAR_DAY.exec(isoDate.trim());
  if (match === null) throw new DomainError(DOMAIN_ERROR.CANVAS_DATE, 'Дата канваса — календарный день');
  const captured = match.slice(1);
  const year = Number(captured[0]);
  const month = Number(captured[1]);
  const day = Number(captured[1 + 1]);
  return Date.UTC(year, month - 1, day);
}

/** Сколько календарных суток между двумя датами `YYYY-MM-DD`. Отрицательное — вторая раньше. */
export function calendarDaysBetween(earlier: string, later: string): number {
  return (utcMidnight(later) - utcMidnight(earlier)) / millisecondsInDay();
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
