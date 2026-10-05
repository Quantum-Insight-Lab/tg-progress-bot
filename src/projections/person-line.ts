import type { CanvasParagraph } from './canvas-message.ts';

/** Строка человека, когда логин GitHub не записан. */
export const PERSON_LINE_UNMATCHED = 'нет сопоставления с GitHub';

/** Счётчики среза 3.4. Чужие логины в строку не входят. */
export interface PersonLineSlice {
  name: string;
  done: number;
  now: number;
  next: number;
}

export type PersonCanvasLine = { kind: 'unmatched' } | { kind: 'absent' } | ({ kind: 'slice' } & PersonLineSlice);

/** Место, которое уже посчитал домен: списки номеров, отсутствие логина или репозитория. */
export interface PersonLinePlace {
  name: string;
  place:
    | { kind: 'unmatched' }
    | { kind: 'absent' }
    | { kind: 'slice'; done: readonly number[]; now: readonly number[]; next: readonly number[] };
}

/**
 * «имя по issues: сделал N · сейчас на нём N · дальше в репозитории N».
 * Без логина строка целиком — «нет сопоставления с GitHub».
 * Без репозитория строки нет.
 */
export function personLineParagraphs(line: PersonCanvasLine): CanvasParagraph[] {
  if (line.kind === 'absent') return [];
  if (line.kind === 'unmatched') {
    return [{ pieces: [{ kind: 'bold', text: PERSON_LINE_UNMATCHED }] }];
  }
  const name = line.name.trim();
  if (name.length === 0) throw new Error('у строки человека есть имя');
  return [
    {
      pieces: [
        { kind: 'bold', text: `${name} по issues:` },
        {
          kind: 'text',
          text: ` сделал ${String(line.done)} · сейчас на нём ${String(line.now)} · дальше в репозитории ${String(line.next)}`,
        },
      ],
    },
  ];
}

/** Числа строки — длины среза. Логин assignee в текст не попадает. */
export function personLineFromPlace(person: PersonLinePlace): PersonCanvasLine {
  if (person.place.kind === 'unmatched') return { kind: 'unmatched' };
  if (person.place.kind === 'absent') return { kind: 'absent' };
  return {
    kind: 'slice',
    name: person.name,
    done: person.place.done.length,
    now: person.place.now.length,
    next: person.place.next.length,
  };
}
