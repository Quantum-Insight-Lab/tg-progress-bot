import { RICH_MESSAGE_MAX_BLOCKS, RICH_MESSAGE_MAX_CHARS } from '../../config/constants.ts';

/** Срез issues: «Сделано», «В работе», «Далее». Ужимается первым. */
export const CANVAS_FIT_SLICE = 'slice';

/** Блок «Блокеры». Ужимается после срезов. */
export const CANVAS_FIT_BLOCKERS = 'blockers';

/** Строка динамики. Ужимается последней. */
export const CANVAS_FIT_DYNAMICS = 'dynamics';

/** Блок «Задачи». При ужатии не выкидывается. */
export const CANVAS_FIT_TASKS = 'tasks';

/** Шапка и остальные блоки. Ужатие их не трогает. */
export const CANVAS_FIT_KEEP = 'keep';

const SHRINK_ORDER = [CANVAS_FIT_SLICE, CANVAS_FIT_BLOCKERS, CANVAS_FIT_DYNAMICS] as const;

export const CANVAS_FIT_KINDS = [...SHRINK_ORDER, CANVAS_FIT_TASKS, CANVAS_FIT_KEEP] as const;

export type CanvasFitKind = (typeof CANVAS_FIT_KINDS)[number];

/** Один абзац канваса: видимый текст и число блоков rich message. */
export interface CanvasFitPart {
  kind: CanvasFitKind;
  chars: number;
  blocks: number;
}

export type CanvasFit =
  | { status: 'ready'; shrunk: boolean; kept: number[] }
  | { status: 'full'; kept: number[] };

function exceeds(parts: readonly CanvasFitPart[], indexes: readonly number[]): boolean {
  let chars = 0;
  let blocks = 0;
  for (const index of indexes) {
    const part = parts[index];
    if (part === undefined) continue;
    chars += part.chars;
    blocks += part.blocks;
  }
  return chars > RICH_MESSAGE_MAX_CHARS || blocks > RICH_MESSAGE_MAX_BLOCKS;
}

/** Позиция в `indexes` последнего абзаца этой группы. `-1`, если таких нет. */
function lastOf(parts: readonly CanvasFitPart[], indexes: readonly number[], kind: CanvasFitKind): number {
  let found = -1;
  for (let cursor = 0; cursor < indexes.length; cursor += 1) {
    const index = indexes[cursor];
    if (index === undefined) continue;
    if (parts[index]?.kind === kind) found = cursor;
  }
  return found;
}

/**
 * A-31, C-8, C-9. Текст не влезает в лимит rich message — сначала ужимаются срезы issues,
 * затем блокеры, затем динамика. Задачи не выкидываются.
 * Если не влезают уже они, канвас заполнен.
 */
export function fitCanvas(parts: readonly CanvasFitPart[]): CanvasFit {
  const kept = parts.map((_, index) => index);
  if (!exceeds(parts, kept)) return { status: 'ready', shrunk: false, kept };
  let shrunk = false;
  for (const kind of SHRINK_ORDER) {
    let cursor = lastOf(parts, kept, kind);
    while (cursor >= 0 && exceeds(parts, kept)) {
      kept.splice(cursor, 1);
      shrunk = true;
      cursor = lastOf(parts, kept, kind);
    }
  }
  if (exceeds(parts, kept)) return { status: 'full', kept };
  return { status: 'ready', shrunk, kept };
}
