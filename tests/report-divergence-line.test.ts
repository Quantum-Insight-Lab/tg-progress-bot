import { describe, expect, it } from 'vitest';
import { DIVERGENCE_LINE } from '../src/projections/divergence-line.ts';
import { reportProjectBacklogLines, type ReportProjectBacklogView } from '../src/projections/report-backlog-block.ts';
import { reportDivergenceLines } from '../src/projections/report-divergence-line.ts';
import { reportWorkLines } from '../src/projections/report-work-lines.ts';

const sensor: ReportProjectBacklogView = {
  projectName: 'Общественный сенсор',
  shareAtStart: { completed: 13, remaining: 18, ratio: 13 / 31 },
  shareAtEnd: { completed: 14, remaining: 17, ratio: 14 / 31 },
  remainderAtEnd: { remaining: 17, total: 31 },
  closed: [{ number: 11, title: 'Telegram-интерфейс' }],
  openedNew: [{ number: 12, title: 'Новая форма' }],
  confirmedOn: [],
};

const quietCount = 41;
const quietTitles = ['Тихий сигнал', 'Без комментария', 'Без коммита', 'Без запроса'] as const;

function isolated(text: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${String(value)}(?:\\D|$)`).test(text);
}

function projectBlock(name: string, divergence: boolean): string {
  return [
    ...reportProjectBacklogLines({ ...sensor, projectName: name }),
    ...reportWorkLines({
      now: [],
      next: [],
      reasons: [{ text: 'нет стабильного доступа к одному из источников данных' }],
      defaultBranchCiRed: true,
      pullRequests: [{ pullRequestNumber: 138, ciRed: true }],
      showAssignee: false,
    }),
    ...reportDivergenceLines(divergence),
  ].join('\n');
}

describe('строка расхождения в блоке проекта отчёта', () => {
  it('R-689 «В репозитории есть движение, в задачах за сутки тишина» печатается в блоке того проекта', () => {
    const loud = projectBlock('Общественный сенсор', true);
    const quiet = projectBlock('Тихий проект', false);
    expect(reportDivergenceLines(true)).toEqual([DIVERGENCE_LINE]);
    expect(loud.startsWith('Общественный сенсор\n')).toBe(true);
    expect(loud).toContain('Бэклог: 42% → 45% · осталось 17 из 31');
    expect(loud).toContain(DIVERGENCE_LINE);
    expect(loud.endsWith(DIVERGENCE_LINE)).toBe(true);
    expect(quiet.startsWith('Тихий проект\n')).toBe(true);
    expect(quiet).not.toContain(DIVERGENCE_LINE);
    expect(reportDivergenceLines(false)).toEqual([]);
  });

  it('R-279 и в отчёт не печатается', () => {
    const text = projectBlock('Общественный сенсор', false);
    expect(text).not.toContain('тихих');
    expect(text).not.toMatch(/issue/i);
    expect(isolated(text, quietCount)).toBe(false);
    for (const title of quietTitles) expect(text).not.toContain(title);
  });
});
