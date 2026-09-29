import type { ReportWindow, ReportWindows } from '../domain/projects/deliver-report.ts';
import { projectCalendarDate, projectClock } from '../domain/shared/project-time.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function zoneOffsetMs(instant: Date, timezone: string): number {
  const clock = projectClock(instant, timezone);
  const dateParts = clock.date.split('-');
  const timeParts = clock.time.split(':');
  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]);
  const day = Number(dateParts[2]);
  const hour = Number(timeParts[0]);
  const minute = Number(timeParts[1]);
  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'таймзона не распознана');
  }
  return Date.UTC(year, month - 1, day, hour, minute, 0) - instant.getTime();
}

/** Начало календарных суток `YYYY-MM-DD` в таймзоне. */
export function zonedDayStart(date: string, timezone: string): Date {
  const match = CALENDAR_DAY.exec(date.trim());
  if (match === null) throw new DomainError(DOMAIN_ERROR.CANVAS_DATE, 'Дата — календарный день');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const midnight = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = zoneOffsetMs(new Date(midnight), timezone);
  let start = midnight - first;
  const second = zoneOffsetMs(new Date(start), timezone);
  if (second !== first) start = midnight - second;
  return new Date(start);
}

/** Окно отчёта: от местной полуночи до момента запроса. */
export function reportWindows(now: Date): ReportWindows {
  return (timezone) => {
    const date = projectCalendarDate(now, timezone);
    const window: ReportWindow = {
      date,
      periodStart: zonedDayStart(date, timezone).toISOString(),
      periodEnd: now.toISOString(),
    };
    return window;
  };
}
