export type Instant = {
  iso: string;
  epochMs: number;
  timeZone: string;
};

export type Clock = {
  now: (timeZone: string) => Instant;
  calendarDate: (timeZone: string) => string;
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
  };
}

/** Единственная реализация системного времени (S-4, S-10). */
export const clock = createClock();
