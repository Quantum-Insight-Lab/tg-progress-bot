import { constants } from "../../config/index.js";

export function defaultDailyCron(): string {
  const { hour, minute } = constants.reportSchedule.daily;
  return `${String(minute)} ${String(hour)} * * *`;
}

export function dailyPeriodKey(calendarDate: string): string {
  return calendarDate;
}

export function reportSentKey(input: {
  reportType: "daily" | "weekly";
  destination: "dm" | "group";
  chatId: number;
  periodKey: string;
}): string {
  return `${input.reportType}:${input.destination}:${String(input.chatId)}:${input.periodKey}`;
}

/** C-7: cron `m h * * *` совпадает с часом и минутой в таймзоне проекта. */
export function isDailyCronDue(
  cron: string,
  hour: number,
  minute: number,
): boolean {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (match === null) {
    return false;
  }
  const cronMinute = Number.parseInt(match[1] ?? "", 10);
  const cronHour = Number.parseInt(match[2] ?? "", 10);
  return cronHour === hour && cronMinute === minute;
}
