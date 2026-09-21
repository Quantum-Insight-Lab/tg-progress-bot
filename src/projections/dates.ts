import { clock } from "../infrastructure/clock.js";

export function dateLabel(iso: string, timeZone: string): string {
  const calendar = clock.calendarDateAt(iso, timeZone);
  const [year, month, day] = calendar.split("-");
  if (year === undefined || month === undefined || day === undefined) {
    return iso;
  }
  return `${day}.${month}.${year}`;
}
