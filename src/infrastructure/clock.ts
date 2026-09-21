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
  };
}

/** Единственная реализация системного времени (S-4, S-10). */
export const clock = createClock();
