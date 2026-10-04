import { describe, expect, it } from 'vitest';
import { CANVAS_SLICE_SIZE } from '../src/config/constants.ts';
import { renderCanvas, type CanvasRichMessage, type CanvasRichText } from '../src/projections/canvas-message.ts';
import {
  SLICE_DONE_HEADING,
  SLICE_IN_PROGRESS_HEADING,
  SLICE_NEXT_HEADING,
  doneSliceParagraphs,
  inProgressSliceParagraphs,
  nextSliceParagraphs,
  type SliceInProgressLine,
  type SliceIssueLine,
} from '../src/projections/issue-slice.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const done: SliceIssueLine[] = [
  { number: 4, title: 'архитектура проекта' },
  { number: 8, title: 'структура базы данных' },
  { number: 11, title: 'Telegram-интерфейс' },
];

const inProgress: SliceInProgressLine[] = [
  { number: 40, title: 'классификация сигналов', assigneeName: 'Андрей' },
  { number: 44, title: 'AI-интервьюер', assigneeName: 'Мария' },
];

const next: SliceIssueLine[] = [
  { number: 51, title: 'кластеризация похожих сигналов' },
  { number: 56, title: 'публичная карточка проблемы' },
];

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.flatMap((block) => visible(block.text).split('\n'));
}

function painted(): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate: '2026-09-17',
    sections: {
      done: doneSliceParagraphs(done),
      inProgress: inProgressSliceParagraphs(inProgress),
      next: nextSliceParagraphs(next),
    },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return linesOf(prepared.message);
}

const lines = painted();

describe('срез issues на канвасе', () => {
  it('R-115 «Сделано»', () => {
    expect(lines).toContain(SLICE_DONE_HEADING);
    expect(lines).toContain('Сделано');
    expect(lines.indexOf('Сделано')).toBeGreaterThan(0);
    expect(lines.indexOf('Сделано')).toBeGreaterThan(lines.indexOf('В работе'));
    expect(doneSliceParagraphs([])).toEqual([]);
    const empty = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: { done: [] },
    });
    expect(linesOf(empty)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
  });

  it('R-116 «#4 архитектура проекта»', () => {
    expect(lines).toContain('#4 архитектура проекта;');
  });

  it('R-117 «В работе»', () => {
    expect(lines).toContain(SLICE_IN_PROGRESS_HEADING);
    expect(lines).toContain('В работе');
    expect(lines.indexOf('В работе')).toBeLessThan(lines.indexOf('Сделано'));
    expect(lines.indexOf('В работе')).toBeLessThan(lines.indexOf('Далее'));
    expect(inProgressSliceParagraphs([])).toEqual([]);
  });

  it('R-118 «#40 классификация сигналов»', () => {
    expect(lines).toContain('#40 классификация сигналов — Андрей;');
    expect(lines.join('\n')).toContain('#40 классификация сигналов');
  });

  it('R-119 «— Андрей»', () => {
    const row = lines.find((line) => line.includes('#40'));
    expect(row).toBe('#40 классификация сигналов — Андрей;');
    expect(row).toContain('— Андрей;');
    expect(lines).toContain('#44 AI-интервьюер — Мария.');
  });

  it('R-120 «Далее»', () => {
    expect(lines).toContain(SLICE_NEXT_HEADING);
    expect(lines).toContain('Далее');
    expect(lines.indexOf('Далее')).toBeGreaterThan(lines.indexOf('В работе'));
    expect(nextSliceParagraphs([])).toEqual([]);
  });

  it('R-121 «#51 кластеризация похожих сигналов»', () => {
    expect(lines).toContain('#51 кластеризация похожих сигналов;');
    expect(lines).toContain('#56 публичная карточка проблемы.');
  });

  it('R-140 короткий срез', () => {
    const overflow = CANVAS_SLICE_SIZE + 1;
    const many: SliceIssueLine[] = [];
    for (let index = 0; index < overflow; index += 1) {
      many.push({ number: index + 1, title: `лишний пункт ${String(index + 1)}` });
    }
    const working: SliceInProgressLine[] = many.map((issue) => ({ ...issue, assigneeName: 'Андрей' }));
    const prepared = prepareCanvasMessage({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        done: doneSliceParagraphs(many),
        inProgress: inProgressSliceParagraphs(working),
        next: nextSliceParagraphs(many),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    const shown = linesOf(prepared.message);
    const dropped = `лишний пункт ${String(overflow)}`;
    expect(shown.join('\n')).not.toContain(dropped);
    expect(shown.filter((line) => line.startsWith('#')).length).toBe(CANVAS_SLICE_SIZE * 3);
    expect(shown.filter((line) => line.startsWith('#') && line.includes('— Андрей')).length).toBe(CANVAS_SLICE_SIZE);
    expect(shown).toContain('Сделано');
    expect(shown).toContain('В работе');
    expect(shown).toContain('Далее');
  });
});
