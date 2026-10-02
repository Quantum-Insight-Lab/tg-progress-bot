import { HOURS_PER_DAY, MINUTES_PER_HOUR, UTC_OFFSET_EAST_HOURS, UTC_OFFSET_WEST_HOURS } from '../../config/constants.ts';
import { DOMAIN_ERROR, DomainError } from './errors.ts';

const OFFSET_MINUTES = /^([+-])(\d+)$/;
const LOCAL_HOUR = /^(?:[0-9]|1[0-9]|2[0-3])$/;

/** Строка сдвига, как она лежит в `timezone`. Чужое имя сюда не попадает. */
export function formatOffsetMinutes(minutes: number): string {
  if (minutes < 0) return `-${String(-minutes)}`;
  return `+${String(minutes)}`;
}

/** Минуты сдвига, если строка — целые часы в допустимых пределах. Иначе имя зоны или мусор. */
export function parseOffsetMinutes(value: string): number | null {
  const match = OFFSET_MINUTES.exec(value.trim());
  if (match === null) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const minutes = sign * Number(match[1 + 1]);
  if (!Number.isInteger(minutes) || minutes % MINUTES_PER_HOUR !== 0) return null;
  const hours = minutes / MINUTES_PER_HOUR;
  if (hours < -UTC_OFFSET_WEST_HOURS || hours > UTC_OFFSET_EAST_HOURS) return null;
  return minutes;
}

/** Ответ «сколько сейчас»: час 0–23, без минут и без ведущего нуля. */
export function isLocalHour(value: string): boolean {
  return LOCAL_HOUR.test(value.trim());
}

/**
 * Сдвиг в момент ответа. Час человека минус час UTC.
 * Разница больше западного предела вычитает сутки, меньше его с минусом — прибавляет.
 */
export function offsetFromLocalHour(hour: number, now: Date): string {
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'нужен час от 0 до 23');
  }
  let diff = hour - now.getUTCHours();
  if (diff > UTC_OFFSET_WEST_HOURS) diff -= HOURS_PER_DAY;
  if (diff < -UTC_OFFSET_WEST_HOURS) diff += HOURS_PER_DAY;
  const stored = formatOffsetMinutes(diff * MINUTES_PER_HOUR);
  if (parseOffsetMinutes(stored) === null) {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_TIMEZONE, 'нужен час от 0 до 23');
  }
  return stored;
}

/** Имя для `Intl`: знак Etc/GMT обратный гражданскому. Чужое имя возвращается как есть. */
export function zoneForClock(value: string): string {
  const minutes = parseOffsetMinutes(value);
  if (minutes === null) return value;
  const hours = minutes / MINUTES_PER_HOUR;
  if (hours === 0) return 'Etc/UTC';
  if (hours > 0) return `Etc/GMT-${String(hours)}`;
  return `Etc/GMT+${String(-hours)}`;
}

/** Как показать сдвиг человеку. Чужое имя остаётся как записано. */
export function offsetLabel(value: string): string {
  const minutes = parseOffsetMinutes(value);
  if (minutes === null) return value;
  const hours = minutes / MINUTES_PER_HOUR;
  if (hours > 0) return `UTC+${String(hours)}`;
  if (hours < 0) return `UTC${String(hours)}`;
  return 'UTC+0';
}
