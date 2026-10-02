import { describe, expect, it } from 'vitest';
import { projectClock } from '../src/domain/shared/project-time.ts';
import { isLocalHour, offsetFromLocalHour, offsetLabel, parseOffsetMinutes } from '../src/domain/shared/utc-offset.ts';
import { offsetOfZoneName } from '../src/infrastructure/zone-names.ts';
import { newProjectSample } from '../src/projections/onboarding-next.ts';
import { scheduleTemplate } from '../src/telegram/schedule.ts';

const atSevenUtc = new Date('2026-09-28T07:33:00.000Z');

describe('час человека вместо имени зоны', () => {
  it('R-967 четвёртая строка проекта — час, не имя зоны', () => {
    expect(newProjectSample().endsWith('<час>')).toBe(true);
    expect(isLocalHour('14')).toBe(true);
    expect(isLocalHour('Asia/Tomsk')).toBe(false);
    expect(isLocalHour('14:13')).toBe(false);
  });

  it('R-968 четырнадцать при UTC 7 — сдвиг +7 часов, город не выбирается', () => {
    expect(offsetFromLocalHour(14, atSevenUtc)).toBe('+420');
    expect(offsetFromLocalHour(1, new Date('2026-01-01T22:00:00.000Z'))).toBe('+180');
    expect(parseOffsetMinutes('+420')).toBe(420);
    expect(offsetLabel('+420')).toBe('UTC+7');
    expect(projectClock(atSevenUtc, '+420').time).toBe('14:33');
  });

  it('R-970 расписание спрашивает только час отчёта', () => {
    expect(scheduleTemplate('Альфа').split('\n')).toEqual(['Время отчёта', 'Альфа', '<время>']);
  });

  it('R-972 понятное имя становится сдвигом, непонятное остаётся', () => {
    expect(offsetOfZoneName(new Date('2026-01-15T00:00:00.000Z'), 'Asia/Tomsk')).toBe('+420');
    expect(offsetOfZoneName(new Date('2026-01-15T00:00:00.000Z'), 'Russia/Tomsk')).toBeNull();
    expect(offsetOfZoneName(atSevenUtc, '+180')).toBeNull();
  });
});
