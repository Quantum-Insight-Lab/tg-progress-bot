import { describe, expect, it } from 'vitest';
import { RICH_MESSAGE_MAX_BLOCKS, RICH_MESSAGE_MAX_CHARS } from '../src/config/constants.ts';
import {
  CANVAS_FIT_BLOCKERS,
  CANVAS_FIT_DYNAMICS,
  CANVAS_FIT_KEEP,
  CANVAS_FIT_SLICE,
  CANVAS_FIT_TASKS,
  fitCanvas,
  type CanvasFitKind,
  type CanvasFitPart,
} from '../src/domain/tasks/fit-canvas.ts';
import type { CanvasParagraph } from '../src/projections/canvas-message.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

function part(kind: CanvasFitKind, chars: number, blocks = 1): CanvasFitPart {
  return { kind, chars, blocks };
}

function kinds(parts: readonly CanvasFitPart[], kept: readonly number[]): CanvasFitKind[] {
  return kept.map((index) => {
    const item = parts[index];
    if (item === undefined) throw new Error('абзац ужатия потерян');
    return item.kind;
  });
}

function text(value: string): CanvasParagraph {
  return { pieces: [{ kind: 'text', text: value }] };
}

describe('лимит rich message', () => {
  it('R-614 лимит 32768 символов: ровно лимит проходит, лишний символ среза ужимается', () => {
    expect(RICH_MESSAGE_MAX_CHARS).toBe(32768);
    const exact = [part(CANVAS_FIT_TASKS, RICH_MESSAGE_MAX_CHARS)];
    expect(fitCanvas(exact)).toEqual({ status: 'ready', shrunk: false, kept: [0] });
    const parts = [part(CANVAS_FIT_SLICE, 1), part(CANVAS_FIT_TASKS, RICH_MESSAGE_MAX_CHARS)];
    const fitted = fitCanvas(parts);
    expect(fitted.status).toBe('ready');
    if (fitted.status !== 'ready') return;
    expect(fitted.shrunk).toBe(true);
    expect(kinds(parts, fitted.kept)).toEqual([CANVAS_FIT_TASKS]);
  });

  it('R-615 лимит 500 блоков: ровно лимит проходит, лишний блок среза ужимается', () => {
    expect(RICH_MESSAGE_MAX_BLOCKS).toBe(500);
    const exact = Array.from({ length: RICH_MESSAGE_MAX_BLOCKS }, () => part(CANVAS_FIT_KEEP, 1));
    const fitted = fitCanvas(exact);
    expect(fitted.status).toBe('ready');
    if (fitted.status !== 'ready') return;
    expect(fitted.shrunk).toBe(false);
    expect(fitted.kept).toHaveLength(RICH_MESSAGE_MAX_BLOCKS);
    const over = [...exact, part(CANVAS_FIT_SLICE, 1)];
    const shrunk = fitCanvas(over);
    expect(shrunk.status).toBe('ready');
    if (shrunk.status !== 'ready') return;
    expect(shrunk.shrunk).toBe(true);
    expect(shrunk.kept).toEqual(exact.map((_, index) => index));
  });

  it('R-629 R-630 R-631 сначала срезы, затем блокеры, затем динамика', () => {
    const parts = [
      part(CANVAS_FIT_SLICE, RICH_MESSAGE_MAX_CHARS),
      part(CANVAS_FIT_TASKS, RICH_MESSAGE_MAX_CHARS),
      part(CANVAS_FIT_BLOCKERS, 1),
      part(CANVAS_FIT_DYNAMICS, 1),
    ];
    const fitted = fitCanvas(parts);
    expect(fitted.status).toBe('ready');
    if (fitted.status !== 'ready') return;
    expect(fitted.shrunk).toBe(true);
    expect(kinds(parts, fitted.kept)).toEqual([CANVAS_FIT_TASKS]);
  });

  it('INV-09 ужатие не выкидывает задачи; если не влезают они — отказ', () => {
    const parts = [
      part(CANVAS_FIT_SLICE, 1),
      part(CANVAS_FIT_TASKS, 1),
      part(CANVAS_FIT_BLOCKERS, 1),
      part(CANVAS_FIT_DYNAMICS, 1),
    ];
    const overChars = parts.map((item, index) =>
      index === 1 ? part(CANVAS_FIT_TASKS, RICH_MESSAGE_MAX_CHARS) : item,
    );
    const shrunk = fitCanvas(overChars);
    expect(shrunk.status).toBe('ready');
    if (shrunk.status !== 'ready') return;
    expect(kinds(overChars, shrunk.kept)).toContain(CANVAS_FIT_TASKS);
    const overflow = [part(CANVAS_FIT_TASKS, RICH_MESSAGE_MAX_CHARS + 1), part(CANVAS_FIT_SLICE, 1)];
    const full = fitCanvas(overflow);
    expect(full.status).toBe('full');
    expect(kinds(overflow, full.kept)).toEqual([CANVAS_FIT_TASKS]);
    const blocks = [
      ...Array.from({ length: RICH_MESSAGE_MAX_BLOCKS }, () => part(CANVAS_FIT_KEEP, 1)),
      part(CANVAS_FIT_TASKS, 1),
    ];
    const blocked = fitCanvas(blocks);
    expect(blocked.status).toBe('full');
    expect(kinds(blocks, blocked.kept)).toContain(CANVAS_FIT_TASKS);
  });

  it('R-632 задачи остаются в сообщении, срезы уходят', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: {
        done: [text('срез'.repeat(RICH_MESSAGE_MAX_CHARS))],
        tasks: [text('Задачи'), text('◻️ 1 — сигнал')],
        blockers: [text('блокер')],
        dynamics: [text('27.08 — 24%')],
      },
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    expect(prepared.shrunk).toBe(true);
    const raw = JSON.stringify(prepared.message);
    expect(raw).toContain('◻️ 1 — сигнал');
    expect(raw).toContain('Задачи');
    expect(raw).not.toContain('срез');
  });

  it('R-633 задачи сверх лимита — канвас заполнен, задачи в отказе остаются', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: {
        tasks: [text('з'.repeat(RICH_MESSAGE_MAX_CHARS + 1))],
        done: [text('срез')],
      },
    });
    expect(prepared.status).toBe('full');
  });
});
