import { projectClock, calendarDaysBetween } from '../domain/shared/project-time.ts';
import { formatOffsetMinutes, parseOffsetMinutes } from '../domain/shared/utc-offset.ts';
import type { MigrationSql } from './db.ts';

const MINUTES_PER_DAY = 24 * 60;

/**
 * Понятное имя зоны → текущий сдвиг в минутах.
 * Непонятное имя и сдвиг не на целом часе остаются как есть.
 */
export function offsetOfZoneName(now: Date, zone: string): string | null {
  if (parseOffsetMinutes(zone) !== null) return null;
  let clock: { date: string; time: string };
  try {
    clock = projectClock(now, zone);
  } catch {
    return null;
  }
  const [hourText, minuteText] = clock.time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const utcDate = now.toISOString().slice(0, 10);
  const minutes =
    calendarDaysBetween(utcDate, clock.date) * MINUTES_PER_DAY +
    hour * 60 +
    minute -
    (now.getUTCHours() * 60 + now.getUTCMinutes());
  if (minutes % 60 !== 0) return null;
  const stored = formatOffsetMinutes(minutes);
  if (parseOffsetMinutes(stored) === null) return null;
  return stored;
}

/** Одна проходка по `projects` и `chats`. Повтор не трогает уже записанный сдвиг. */
export async function convertStoredZoneNames(sql: MigrationSql, now: Date): Promise<number> {
  let changed = 0;
  for (const table of ['projects', 'chats']) {
    const rows = await sql.query(`SELECT DISTINCT timezone FROM ${table}`);
    for (const row of rows) {
      const zone = row.timezone;
      if (typeof zone !== 'string') continue;
      const offset = offsetOfZoneName(now, zone);
      if (offset === null) continue;
      await sql.query(`UPDATE ${table} SET timezone = $1 WHERE timezone = $2`, [offset, zone]);
      changed += 1;
    }
  }
  return changed;
}
