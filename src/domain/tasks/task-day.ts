import { calendarDaysBetween } from '../shared/project-time.ts';

/**
 * Какой день задачи идёт на дате канваса.
 * Обе даты — календарные сутки проекта. День создания — первый.
 */
export function taskCanvasDay(createdOn: string, canvasDate: string): number {
  return calendarDaysBetween(createdOn, canvasDate) + 1;
}
