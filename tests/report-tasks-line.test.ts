import { describe, expect, it } from 'vitest';
import { reportTasksLine } from '../src/projections/report-tasks-line.ts';

const daily = { confirmed: 1, created: 2, cancelled: 0, blocked: 1 };
const line = 'Задачи: подтверждено 1 · создано 2 · отменено 0 · встало в блок 1';

describe('строка задач отчёта', () => {
  it('R-674 «Задачи»', () => {
    expect(reportTasksLine(daily)).toBe(line);
    expect(reportTasksLine(daily).startsWith('Задачи: ')).toBe(true);
  });

  it('R-675 «подтверждено 1»', () => {
    expect(reportTasksLine(daily)).toContain('подтверждено 1');
  });

  it('R-676 «создано 2»', () => {
    expect(reportTasksLine(daily)).toContain('создано 2');
  });

  it('R-677 «отменено 0»', () => {
    expect(reportTasksLine(daily)).toContain('отменено 0');
  });

  it('R-678 «встало в блок 1»', () => {
    expect(reportTasksLine(daily)).toContain('встало в блок 1');
  });

  it('ноль печатается, дробь и минус — нет', () => {
    expect(reportTasksLine({ confirmed: 0, created: 0, cancelled: 0, blocked: 0 })).toBe(
      'Задачи: подтверждено 0 · создано 0 · отменено 0 · встало в блок 0',
    );
    expect(() => reportTasksLine({ confirmed: -1, created: 0, cancelled: 0, blocked: 0 })).toThrow(
      'счётчик задач отчёта — целое от нуля',
    );
    expect(() => reportTasksLine({ confirmed: 1.5, created: 0, cancelled: 0, blocked: 0 })).toThrow(
      'счётчик задач отчёта — целое от нуля',
    );
  });
});
