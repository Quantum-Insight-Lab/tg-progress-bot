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

function parseDailyCron(
  cron: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (match === null) {
    return null;
  }
  return {
    minute: Number.parseInt(match[1] ?? "", 10),
    hour: Number.parseInt(match[2] ?? "", 10),
  };
}

/** C-7: cron `m h * * *` совпадает с часом и минутой в таймзоне проекта. */
export function isDailyCronDue(
  cron: string,
  hour: number,
  minute: number,
): boolean {
  const parsed = parseDailyCron(cron);
  if (parsed === null) {
    return false;
  }
  return parsed.hour === hour && parsed.minute === minute;
}

/** Минута cron уже прошла, прогон не состоялся. */
export function isDailyCronMissed(
  cron: string,
  hour: number,
  minute: number,
): boolean {
  const parsed = parseDailyCron(cron);
  if (parsed === null) {
    return false;
  }
  if (hour > parsed.hour) {
    return true;
  }
  return hour === parsed.hour && minute > parsed.minute;
}
