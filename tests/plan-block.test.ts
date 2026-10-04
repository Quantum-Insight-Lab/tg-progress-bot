import { describe, expect, it } from 'vitest';
import {
  TASK_PRIORITY_HIGH,
  TASK_PRIORITY_LOW,
  TASK_PRIORITY_NORMAL,
  TASK_STATUS_PLANNED,
} from '../src/domain/tasks/status.ts';
import {
  CANVAS_LINK_STYLE,
  renderCanvas,
  type CanvasRichMessage,
  type CanvasRichText,
  type CanvasTextButton,
} from '../src/projections/canvas-message.ts';
import {
  PLAN_BLOCK_HEADING,
  TASK_RESUME_LABEL,
  planBlockParagraphs,
  planFirstLine,
} from '../src/projections/plan-block.ts';
import {
  TASK_CANCEL_LABEL,
  TASK_MARK_ACTION,
  TASK_OPEN_MARK,
  TASK_PLAN_LABEL,
  TASK_PRIORITY_ACTION,
  TASK_RESUME_ACTION,
  TASK_REVIEW_MARK,
  taskCanvasActionData,
  type TaskFirstLine,
} from '../src/projections/tasks-block.ts';

const highLine: TaskFirstLine = {
  number: 7,
  title: 'Классификация сигнала',
  status: TASK_STATUS_PLANNED,
  day: 3,
  priority: TASK_PRIORITY_HIGH,
};

const normalLine: TaskFirstLine = {
  number: 4,
  title: 'На потом',
  status: TASK_STATUS_PLANNED,
  day: 1,
  priority: TASK_PRIORITY_NORMAL,
};

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function buttonsOf(text: CanvasRichText): CanvasTextButton[] {
  if (typeof text === 'string') return [];
  if (Array.isArray(text)) return text.flatMap(buttonsOf);
  if (text.type === 'bold') return [];
  return [text];
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((block) => visible(block.text));
}

function firstRow(line: string | undefined): string {
  return line?.split('\n')[0] ?? '';
}

function secondRow(line: string | undefined): string {
  return line?.split('\n')[1] ?? '';
}

const block = planBlockParagraphs([highLine, normalLine]);
const canvas = renderCanvas({
  projectName: 'Общественный сенсор',
  canvasDate: '2026-09-17',
  sections: { plan: block },
});
const lines = linesOf(canvas);

describe('блок «План»', () => {
  it('R-494 План', () => {
    expect(lines[1]).toBe(PLAN_BLOCK_HEADING);
    expect(lines[1]).toBe('План');
    expect(lines[2]).toContain('Классификация сигнала');
    expect(lines[3]).toContain('На потом');
    const withTasks = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        tasks: [{ pieces: [{ kind: 'text', text: 'Задачи' }] }],
        plan: block,
      },
    });
    const composed = linesOf(withTasks);
    expect(composed.indexOf('План')).toBeGreaterThan(composed.indexOf('Задачи'));
  });

  it('R-495 его PLANNED', () => {
    expect(block).toHaveLength(3);
    expect(firstRow(lines[2])).toBe(planFirstLine(highLine));
    expect(firstRow(lines[3])).toBe('4 — На потом — 1-й день');
    expect(lines.join('\n')).toContain('7 — Классификация сигнала — 3-й день');
    expect(lines.join('\n')).toContain('4 — На потом — 1-й день');
  });

  it('R-498 пустой план не печатается', () => {
    expect(planBlockParagraphs([])).toEqual([]);
    const empty = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: { plan: [] },
    });
    expect(linesOf(empty)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
    expect(linesOf(empty).join('\n')).not.toContain('План');
  });

  it('R-240 то же слово приоритета есть у задачи в «Плане»', () => {
    const text = canvas.blocks[2]?.text ?? '';
    expect(secondRow(visible(text)).startsWith(`${TASK_PRIORITY_HIGH} · `)).toBe(true);
    expect(secondRow(visible(text)).startsWith('high')).toBe(true);
    const word = buttonsOf(text).find((button) => button.button.text === TASK_PRIORITY_HIGH);
    expect(word?.button.text).toBe('high');
    expect(word?.button.style).toBe(CANVAS_LINK_STYLE);
    expect(word?.button.style).toBe('link');
    expect(word?.button.callback_data).toBe(taskCanvasActionData(TASK_PRIORITY_ACTION, highLine.number));
    expect(word?.button.callback_data).toBe('task:priority:7');
    const low = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        plan: planBlockParagraphs([{ ...highLine, number: 2, priority: TASK_PRIORITY_LOW }]),
      },
    });
    expect(secondRow(linesOf(low)[2]).startsWith('low · ')).toBe(true);
    expect(TASK_PRIORITY_LOW).toBe('low');
    expect(secondRow(lines[3]).startsWith('normal · ')).toBe(true);
  });

  it('R-580 вторая строка задачи в плане — слово приоритета, «в работу» и «отменить»', () => {
    const text = canvas.blocks[2]?.text ?? '';
    expect(secondRow(visible(text))).toBe('high · в работу · отменить');
    const labels = buttonsOf(text).map((button) => button.button.text);
    expect(labels).toEqual([TASK_PRIORITY_HIGH, TASK_RESUME_LABEL, TASK_CANCEL_LABEL]);
    expect(labels).toEqual(['high', 'в работу', 'отменить']);
    const resume = buttonsOf(text).find((button) => button.button.text === 'в работу');
    expect(resume?.button.style).toBe('link');
    expect(resume?.button.callback_data).toBe(taskCanvasActionData(TASK_RESUME_ACTION, 7));
    expect(resume?.button.callback_data).toBe('task:resume:7');
    const cancel = buttonsOf(text).find((button) => button.button.text === 'отменить');
    expect(cancel?.button.text).toBe('отменить');
    expect(cancel?.button.style).toBe('link');
    expect(cancel?.button.callback_data).toBe('task:cancel:7');
    expect(labels).not.toContain(TASK_PLAN_LABEL);
    expect(secondRow(visible(text))).not.toContain('в план');
    expect(secondRow(visible(text))).not.toContain('подтвердить');
    expect(secondRow(visible(text))).not.toContain('вернуть');
  });

  it('R-639 без кнопки галочки', () => {
    const pieces = block[1]?.pieces ?? [];
    expect(pieces[0]).toEqual({ kind: 'text', text: '7 — Классификация сигнала — 3-й день\n' });
    expect(firstRow(lines[2])).toBe('7 — Классификация сигнала — 3-й день');
    expect(firstRow(lines[2]).includes(TASK_OPEN_MARK)).toBe(false);
    expect(firstRow(lines[2]).includes(TASK_REVIEW_MARK)).toBe(false);
    expect(firstRow(lines[2]).includes('◻️')).toBe(false);
    expect(firstRow(lines[2]).includes('✅')).toBe(false);
    const dumped = JSON.stringify(block);
    expect(dumped).not.toContain(`task:${TASK_MARK_ACTION}:`);
    expect(dumped).not.toContain('task:mark:');
    expect(buttonsOf(canvas.blocks[2]?.text ?? '').map((button) => button.button.text)).not.toContain('◻️');
    expect(buttonsOf(canvas.blocks[2]?.text ?? '').map((button) => button.button.text)).not.toContain('✅');
  });

  it('INV-08 абзацы плана стоят в переданном порядке и второй сортировки нет', () => {
    const ordered = planBlockParagraphs([
      { ...highLine, number: 1, title: 'высокий ранний', priority: TASK_PRIORITY_HIGH },
      { ...highLine, number: 2, title: 'высокий поздний', priority: TASK_PRIORITY_HIGH },
      { ...normalLine, number: 3, title: 'обычный', priority: TASK_PRIORITY_NORMAL },
      { ...normalLine, number: 4, title: 'низкий', priority: TASK_PRIORITY_LOW },
    ]);
    const rendered = linesOf(
      renderCanvas({
        projectName: 'Общественный сенсор',
        canvasDate: '2026-09-17',
        sections: { plan: ordered },
      }),
    );
    expect(rendered.slice(2).map(firstRow)).toEqual([
      '1 — высокий ранний — 3-й день',
      '2 — высокий поздний — 3-й день',
      '3 — обычный — 1-й день',
      '4 — низкий — 1-й день',
    ]);
  });
});
