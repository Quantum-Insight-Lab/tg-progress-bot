export type Instant = {
  iso: string;
  epochMs: number;
  timeZone: string;
};

export type Clock = {
  now: (timeZone: string) => Instant;
  calendarDate: (timeZone: string) => string;
  calendarDateAt: (iso: string, timeZone: string) => string;
  daysBetween: (fromDate: string, toDate: string) => number;
  hourMinute: (timeZone: string) => { hour: number; minute: number };
};

export type ClockDeps = {
  current?: () => Date;
};

function calendarDateInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function hourMinuteInZone(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return {
    hour: Number.parseInt(hour ?? "0", 10),
    minute: Number.parseInt(minute ?? "0", 10),
  };
}

function epochUtcOf(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function createClock(deps: ClockDeps = {}): Clock {
  const current = deps.current ?? (() => new Date());
  return {
    now(timeZone: string): Instant {
      const at = current();
      return {
        iso: at.toISOString(),
        epochMs: at.getTime(),
        timeZone,
      };
    },
    calendarDate(timeZone: string): string {
      return calendarDateInZone(current(), timeZone);
    },
    calendarDateAt(iso: string, timeZone: string): string {
      return calendarDateInZone(new Date(iso), timeZone);
    },
    daysBetween(fromDate: string, toDate: string): number {
      const ms = epochUtcOf(toDate) - epochUtcOf(fromDate);
      return Math.round(ms / 86_400_000);
    },
    hourMinute(timeZone: string): { hour: number; minute: number } {
      return hourMinuteInZone(current(), timeZone);
    },
  };
}

/** Единственная реализация системного времени (S-4, S-10). */
export const clock = createClock();
