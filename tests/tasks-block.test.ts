import { describe, expect, it } from 'vitest';
import { tasksBlock } from '../src/domain/tasks/github-link.ts';
import { TASK_PRIORITY_HIGH, TASK_PRIORITY_NORMAL, TASK_STATUS_IN_PROGRESS, TASK_STATUS_REVIEW } from '../src/domain/tasks/status.ts';
import { taskCanvasDay } from '../src/domain/tasks/task-day.ts';
import { defineTask } from '../src/domain/tasks/task.ts';
import { projectCalendarDate } from '../src/domain/shared/project-time.ts';
import { renderCanvas, type CanvasRichMessage } from '../src/projections/canvas-message.ts';
import {
  TASK_OPEN_MARK,
  TASK_REVIEW_MARK,
  TASK_REVIEW_PLACE,
  TASKS_BLOCK_HEADING,
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
};

const reviewLine: TaskFirstLine = {
  number: 9,
  title: 'Черновик карточки',
  status: TASK_STATUS_REVIEW,
  day: 3,
};

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((block) => {
    if (typeof block.text !== 'string') throw new Error('первая строка — текст');
    return block.text;
  });
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
    expect(lines[2]?.startsWith(`${TASK_OPEN_MARK} `)).toBe(true);
    expect(lines[2]?.startsWith('○ ')).toBe(true);
  });

  it('R-124 «7»', () => {
    expect(lines[2]).toContain(' 7 — ');
  });

  it('R-125 «Классификация сигнала»', () => {
    expect(lines[2]).toContain(' — Классификация сигнала — ');
  });

  it('R-126 «3-й день»', () => {
    expect(taskCanvasDay('2026-09-15', '2026-09-17')).toBe(3);
    expect(taskCanvasDay('2026-09-17', '2026-09-17')).toBe(1);
    expect(taskDayMark(3)).toBe('3-й день');
    expect(taskDayMark(1)).toBe('1-й день');
    expect(lines[2]?.endsWith(' — 3-й день')).toBe(true);
    const created = new Date('2026-09-16T21:00:00.000Z');
    expect(taskCanvasDay(projectCalendarDate(created, 'Europe/Moscow'), '2026-09-17')).toBe(1);
    expect(taskCanvasDay(projectCalendarDate(created, 'Pacific/Honolulu'), '2026-09-17')).toBe(2);
  });

  it('R-130 «✓ 9 — Черновик карточки»', () => {
    expect(lines[3]?.startsWith(`${TASK_REVIEW_MARK} 9 — Черновик карточки — `)).toBe(true);
    expect(lines[3]?.startsWith('✓ 9 — Черновик карточки — ')).toBe(true);
  });

  it('R-131 «на подтверждении»', () => {
    expect(lines[3]?.endsWith(` — ${TASK_REVIEW_PLACE}`)).toBe(true);
    expect(lines[3]).toBe('✓ 9 — Черновик карточки — на подтверждении');
    expect(lines[3]).not.toContain('день');
  });

  it('R-491 название с днём на первой строке абзаца', () => {
    expect(lines).toEqual([
      'ПРОЕКТ: Общественный сенсор · 17.09',
      'Задачи',
      '○ 7 — Классификация сигнала — 3-й день',
      '✓ 9 — Черновик карточки — на подтверждении',
    ]);
    expect(block[1]?.pieces).toEqual([{ kind: 'text', text: '○ 7 — Классификация сигнала — 3-й день' }]);
    expect(lines[2]).not.toContain('\n');
    expect(lines.join('\n')).not.toContain('в план');
    expect(lines.join('\n')).not.toContain('отменить');
    expect(lines.join('\n')).not.toContain('подтвердить');
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
            })),
          ),
        },
      }),
    ).join('\n');
    expect(text).toContain(title);
    expect(text).toContain('○ 7 — ');
    expect(text).not.toContain('\n#12');
    expect(text.split('\n')).toHaveLength(3);
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
    expect(lines.join('\n')).not.toMatch(/high|normal|low/);
  });

  it('INV-22 одна задача даёт одну строку, повтор сборки её не удваивает', () => {
    const once = tasksBlockParagraphs([openLine]);
    const twice = tasksBlockParagraphs([openLine]);
    expect(once).toEqual(twice);
    expect(once).toHaveLength(2);
    expect(once[1]?.pieces).toEqual([{ kind: 'text', text: '○ 7 — Классификация сигнала — 3-й день' }]);
  });
});
