import { describe, expect, it } from 'vitest';
import { taskDayMark } from '../src/projections/tasks-block.ts';
import {
  reportNextLine,
  reportNowLine,
  reportNowLines,
  reportRiskLines,
  reportWorkLines,
  type ReportNextLineTask,
  type ReportNowLineTask,
} from '../src/projections/report-work-lines.ts';

const now: ReportNowLineTask = {
  number: 7,
  title: 'Классификация сигнала',
  day: 3,
  assigneeName: 'Андрей',
};

const next: ReportNextLineTask = {
  number: 14,
  title: 'Подготовить тестовые данные',
};

const reason = 'нет стабильного доступа к одному из источников данных';

const topicLine = 'Сейчас: 7 — Классификация сигнала — Андрей, 3-й день';
const nextLine = 'Дальше: 14 — Подготовить тестовые данные';
const riskLine = `Риск: ${reason}`;

describe('макет строк Сейчас, Дальше и Риск', () => {
  it('R-679 «Сейчас: 7 — Классификация сигнала»', () => {
    expect(reportNowLine(now, true)).toBe(topicLine);
    expect(reportNowLine(now, true).startsWith('Сейчас: 7 — Классификация сигнала')).toBe(true);
    expect(reportNowLine({ ...now, assigneeName: null }, false)).toBe('Сейчас: 7 — Классификация сигнала, 3-й день');
  });

  it('R-680 «— Андрей»', () => {
    expect(reportNowLine(now, true)).toContain('— Андрей');
    expect(reportNowLine(now, true)).toBe(topicLine);
    expect(reportNowLine(now, false)).not.toContain('Андрей');
    expect(reportNowLine({ ...now, assigneeName: '   ' }, true)).not.toContain('Андрей');
  });

  it('R-681 «3-й день»', () => {
    expect(taskDayMark(now.day)).toBe('3-й день');
    expect(reportNowLine(now, true)).toContain('3-й день');
    expect(reportNowLine(now, true)).toBe(topicLine);
    expect(reportNowLine(now, false)).toContain('3-й день');
  });

  it('R-682 «Дальше: 14 — Подготовить тестовые данные»', () => {
    expect(reportNextLine(next)).toBe(nextLine);
    expect(reportNextLine(next)).not.toContain('Андрей');
    expect(reportNextLine(next)).not.toContain('день');
  });

  it('R-737 Нет таких — строка не печатается', () => {
    expect(reportNowLines([], true)).toEqual([]);
    expect(reportNowLines([], false)).toEqual([]);
    const lines = reportWorkLines({
      now: [],
      next: [next],
      reasons: [{ text: reason }],
      defaultBranchCiRed: false,
      pullRequests: [],
      showAssignee: true,
    });
    expect(lines.join('\n')).not.toContain('Сейчас');
    expect(lines).toEqual([nextLine, riskLine]);
  });

  it('R-683 Риск: нет стабильного доступа к одному из источников данных', () => {
    expect(reportRiskLines({ reasons: [{ text: reason }], defaultBranchCiRed: false, pullRequests: [] })).toEqual([riskLine]);
    const lines = reportWorkLines({
      now: [now],
      next: [next],
      reasons: [{ text: reason }],
      defaultBranchCiRed: false,
      pullRequests: [],
      showAssignee: true,
    });
    expect(lines).toEqual([topicLine, nextLine, riskLine]);
  });
});
