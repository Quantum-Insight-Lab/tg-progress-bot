import { describe, expect, it } from 'vitest';
import { tasksBlock } from '../src/domain/tasks/github-link.ts';
import {
  TASK_PRIORITY_HIGH,
  TASK_PRIORITY_LOW,
  TASK_PRIORITY_NORMAL,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_REVIEW,
} from '../src/domain/tasks/status.ts';
import { taskCanvasDay } from '../src/domain/tasks/task-day.ts';
import { defineTask } from '../src/domain/tasks/task.ts';
import { projectCalendarDate } from '../src/domain/shared/project-time.ts';
import {
  CANVAS_LINK_STYLE,
  renderCanvas,
  type CanvasRichMessage,
  type CanvasRichText,
  type CanvasTextButton,
} from '../src/projections/canvas-message.ts';
import {
  TASK_CANCEL_LABEL,
  TASK_CONFIRM_LABEL,
  TASK_OPEN_MARK,
  TASK_PLAN_LABEL,
  TASK_RETURN_LABEL,
  TASK_REVIEW_MARK,
  TASK_REVIEW_PLACE,
  TASKS_BLOCK_HEADING,
  taskCanvasActionData,
  taskDayMark,
  taskFirstLine,
  tasksBlockParagraphs,
  type TaskFirstLine,
} from '../src/projections/tasks-block.ts';

const openLine: TaskFirstLine = {
  number: 7,
  title: 'Классификация сигнала',
  status: TASK_STATUS_IN_PROGRESS,
  day: 3,
  priority: TASK_PRIORITY_HIGH,
};

const reviewLine: TaskFirstLine = {
  number: 9,
  title: 'Черновик карточки',
  status: TASK_STATUS_REVIEW,
  day: 3,
  priority: TASK_PRIORITY_NORMAL,
};

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  return text.button.text;
}

function buttonsOf(text: CanvasRichText): CanvasTextButton[] {
  if (typeof text === 'string') return [];
  if (Array.isArray(text)) return text.flatMap(buttonsOf);
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

const block = tasksBlockParagraphs([openLine, reviewLine]);
const canvas = renderCanvas({
  projectName: 'Общественный сенсор',
  canvasDate: '2026-09-17',
  sections: { tasks: block },
});
const lines = linesOf(canvas);

describe('блок «Задачи»: первая строка', () => {
  it('R-122 «Задачи»', () => {
    expect(lines[1]).toBe(TASKS_BLOCK_HEADING);
    expect(lines[1]).toBe('Задачи');
    expect(tasksBlockParagraphs([])).toEqual([]);
    const empty = renderCanvas({ projectName: 'Общественный сенсор', canvasDate: '2026-09-17', sections: { tasks: [] } });
    expect(linesOf(empty)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
  });

  it('R-123 «○»', () => {
    expect(firstRow(lines[2]).startsWith(`${TASK_OPEN_MARK} `)).toBe(true);
    expect(firstRow(lines[2]).startsWith('○ ')).toBe(true);
  });

  it('R-124 «7»', () => {
    expect(firstRow(lines[2])).toContain(' 7 — ');
  });

  it('R-125 «Классификация сигнала»', () => {
    expect(firstRow(lines[2])).toContain(' — Классификация сигнала — ');
  });

  it('R-126 «3-й день»', () => {
    expect(taskCanvasDay('2026-09-15', '2026-09-17')).toBe(3);
    expect(taskCanvasDay('2026-09-17', '2026-09-17')).toBe(1);
    expect(taskDayMark(3)).toBe('3-й день');
    expect(taskDayMark(1)).toBe('1-й день');
    expect(firstRow(lines[2]).endsWith(' — 3-й день')).toBe(true);
    const created = new Date('2026-09-16T21:00:00.000Z');
    expect(taskCanvasDay(projectCalendarDate(created, 'Europe/Moscow'), '2026-09-17')).toBe(1);
    expect(taskCanvasDay(projectCalendarDate(created, 'Pacific/Honolulu'), '2026-09-17')).toBe(2);
  });

  it('R-130 «✓ 9 — Черновик карточки»', () => {
    expect(firstRow(lines[3]).startsWith(`${TASK_REVIEW_MARK} 9 — Черновик карточки — `)).toBe(true);
    expect(firstRow(lines[3]).startsWith('✓ 9 — Черновик карточки — ')).toBe(true);
  });

  it('R-131 «на подтверждении»', () => {
    expect(firstRow(lines[3]).endsWith(` — ${TASK_REVIEW_PLACE}`)).toBe(true);
    expect(firstRow(lines[3])).toBe('✓ 9 — Черновик карточки — на подтверждении');
    expect(firstRow(lines[3])).not.toContain('день');
  });

  it('R-491 название с днём на первой строке абзаца', () => {
    expect(lines.map(firstRow)).toEqual([
      'ПРОЕКТ: Общественный сенсор · 17.09',
      'Задачи',
      '○ 7 — Классификация сигнала — 3-й день',
      '✓ 9 — Черновик карточки — на подтверждении',
    ]);
    expect(block[1]?.pieces[0]).toEqual({ kind: 'text', text: '○ 7 — Классификация сигнала — 3-й день\n' });
    expect(firstRow(lines[2])).not.toContain('\n');
    expect(lines[2]?.split('\n')).toHaveLength(2);
  });

  it('INV-04 блок «Задачи» показывает задачу как есть; факт GitHub строкой не становится', () => {
    const title = 'Смотри https://github.com/org/repo/issues/12 #12';
    const task = defineTask({
      id: '00000000-0000-4000-8000-0000000000aa',
      projectId: '00000000-0000-4000-8000-000000000010',
      number: 7,
      title,
      status: TASK_STATUS_IN_PROGRESS,
      priority: TASK_PRIORITY_NORMAL,
      assigneeId: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-09-17T12:00:00.000Z',
      updatedAt: '2026-09-17T12:00:00.000Z',
      completedAt: null,
    });
    const visible = tasksBlock([
      { source: 'github', fact: 'issue' },
      { source: 'github', fact: 'pull_request' },
      { source: 'github', fact: 'commit' },
      { source: 'github', fact: 'milestone' },
      { source: 'github', fact: 'assignment' },
      { source: 'task', task },
    ]);
    expect(visible).toEqual([task]);
    const text = linesOf(
      renderCanvas({
        projectName: 'Общественный сенсор',
        canvasDate: '2026-09-17',
        sections: {
          tasks: tasksBlockParagraphs(
            visible.map((item) => ({
              number: item.number,
              title: item.title,
              status: item.status,
              day: taskCanvasDay('2026-09-17', '2026-09-17'),
              priority: item.priority,
            })),
          ),
        },
      }),
    ).join('\n');
    expect(text).toContain(title);
    expect(text).toContain('○ 7 — ');
    expect(text).not.toContain('\n#12');
    expect(text.split('\n').filter((row) => row.startsWith('○') || row.startsWith('✓'))).toHaveLength(1);
  });

  it('INV-05 у IN_PROGRESS кружок, у REVIEW — галочка и «на подтверждении»', () => {
    const open = taskFirstLine(openLine);
    const review = taskFirstLine(reviewLine);
    expect(open.startsWith('○')).toBe(true);
    expect(open).not.toContain('✓');
    expect(open).not.toContain('на подтверждении');
    expect(review.startsWith('✓')).toBe(true);
    expect(review).toContain('на подтверждении');
    expect(review).not.toContain('○');
    expect(review).not.toContain('день');
  });

  it('INV-08 первая строка не печатает приоритет', () => {
    const high = taskFirstLine({ ...openLine, title: 'Срочное' });
    const normal = taskFirstLine({ ...reviewLine });
    expect(TASK_PRIORITY_HIGH).toBe('high');
    expect(TASK_PRIORITY_NORMAL).toBe('normal');
    expect(high).not.toMatch(/high|normal|low/);
    expect(normal).not.toMatch(/high|normal|low/);
    expect(lines.map(firstRow).join('\n')).not.toMatch(/high|normal|low/);
  });

  it('INV-22 одна задача даёт один абзац, повтор сборки её не удваивает', () => {
    const once = tasksBlockParagraphs([openLine]);
    const twice = tasksBlockParagraphs([openLine]);
    expect(once).toEqual(twice);
    expect(once).toHaveLength(2);
    expect(once[1]?.pieces[0]).toEqual({ kind: 'text', text: '○ 7 — Классификация сигнала — 3-й день\n' });
    expect(once.filter((paragraph) => paragraph.pieces.some((piece) => piece.kind === 'text' && piece.text.startsWith('○')))).toHaveLength(1);
  });
});

describe('блок «Задачи»: вторая строка', () => {
  const openText = canvas.blocks[2]?.text ?? '';
  const reviewText = canvas.blocks[3]?.text ?? '';

  function labels(text: CanvasRichText): string[] {
    return buttonsOf(text).map((button) => button.button.text);
  }

  it('R-127 «high»', () => {
    expect(secondRow(visible(openText)).startsWith('high · ')).toBe(true);
    expect(secondRow(visible(openText)).startsWith('high')).toBe(true);
  });

  it('R-128 «в план»', () => {
    const plan = buttonsOf(openText).find((button) => button.button.text === 'в план');
    expect(plan?.button.text).toBe(TASK_PLAN_LABEL);
    expect(plan?.button.style).toBe(CANVAS_LINK_STYLE);
    expect(plan?.button.style).toBe('link');
    expect(plan?.button.callback_data).toBe(taskCanvasActionData('plan', 7));
    expect(plan?.button.callback_data).toBe('task:plan:7');
    expect(secondRow(visible(openText))).toContain(' · в план · ');
  });

  it('R-129 «отменить»', () => {
    const cancel = buttonsOf(openText).find((button) => button.button.text === 'отменить');
    expect(cancel?.button.text).toBe(TASK_CANCEL_LABEL);
    expect(cancel?.button.text).toBe('отменить');
    expect(cancel?.button.style).toBe('link');
    expect(cancel?.button.callback_data).toBe('task:cancel:7');
    expect(secondRow(visible(openText)).endsWith(' · отменить')).toBe(true);
  });

  it('R-132 «подтвердить»', () => {
    const confirm = buttonsOf(reviewText).find((button) => button.button.text === 'подтвердить');
    expect(confirm?.button.text).toBe(TASK_CONFIRM_LABEL);
    expect(confirm?.button.text).toBe('подтвердить');
    expect(confirm?.button.style).toBe('link');
    expect(confirm?.button.callback_data).toBe('task:confirm:9');
    expect(labels(reviewText)[0]).toBe('подтвердить');
  });

  it('R-133 «отменить»', () => {
    const cancel = buttonsOf(reviewText).filter((button) => button.button.text === 'отменить');
    expect(cancel).toHaveLength(1);
    expect(cancel[0]?.button.text).toBe('отменить');
    expect(cancel[0]?.button.callback_data).toBe('task:cancel:9');
    expect(secondRow(visible(reviewText)).endsWith(' · отменить')).toBe(true);
  });

  it('R-327 «вернуть»', () => {
    const back = buttonsOf(reviewText).find((button) => button.button.text === 'вернуть');
    expect(back?.button.text).toBe(TASK_RETURN_LABEL);
    expect(back?.button.text).toBe('вернуть');
    expect(back?.button.style).toBe('link');
    expect(back?.button.callback_data).toBe('task:return:9');
  });

  it('R-328 у задачи на подтверждении — ещё «вернуть»', () => {
    expect(labels(reviewText)).toEqual(['подтвердить', 'вернуть', 'отменить']);
    expect(labels(openText)).toEqual(['в план', 'отменить']);
    expect(secondRow(visible(reviewText))).toBe('normal · подтвердить · вернуть · отменить');
    expect(secondRow(visible(openText))).not.toContain('вернуть');
  });

  it('R-143 на второй строке абзаца всегда стоит слово приоритета', () => {
    expect(secondRow(visible(openText)).startsWith(`${TASK_PRIORITY_HIGH}`)).toBe(true);
    expect(secondRow(visible(reviewText)).startsWith('normal')).toBe(true);
    const low = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        tasks: tasksBlockParagraphs([{ ...openLine, number: 2, priority: TASK_PRIORITY_LOW }]),
      },
    });
    const row = secondRow(linesOf(low)[2]);
    expect(row.startsWith('low')).toBe(true);
    expect(TASK_PRIORITY_LOW).toBe('low');
    expect(firstRow(linesOf(low)[2])).not.toMatch(/high|normal|low/);
    expect(low.blocks).toHaveLength(3);
    expect(row.split('\n')).toHaveLength(1);
  });

  it('R-144 затем «в план» или «подтвердить»', () => {
    expect(labels(openText)[0]).toBe('в план');
    expect(labels(openText)).not.toContain('подтвердить');
    expect(labels(reviewText)[0]).toBe('подтвердить');
    expect(labels(reviewText)).not.toContain('в план');
    const blocked = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: { tasks: tasksBlockParagraphs([{ ...openLine, status: TASK_STATUS_BLOCKED }]) },
    });
    expect(labels(blocked.blocks[2]?.text ?? '')[0]).toBe('в план');
    expect(labels(blocked.blocks[2]?.text ?? '')).not.toContain('подтвердить');
    expect(labels(blocked.blocks[2]?.text ?? '')).not.toContain('вернуть');
    expect(JSON.stringify(canvas)).not.toContain('tg-button-row');
    expect(JSON.stringify(canvas)).not.toContain('"type":"buttons"');
  });

  it('R-145 и «отменить»', () => {
    expect(labels(openText).at(-1)).toBe('отменить');
    expect(labels(reviewText).at(-1)).toBe('отменить');
    expect(secondRow(visible(openText))).toBe('high · в план · отменить');
    expect(secondRow(visible(reviewText))).toBe('normal · подтвердить · вернуть · отменить');
  });
});
