import { describe, expect, it } from 'vitest';
import {
  PERIOD_TASK_COUNTER_COMMIT,
  PERIOD_TASK_COUNTER_ISSUE,
  PERIOD_TASK_COUNTER_TASK,
  periodTaskCounters,
  type PeriodTaskCounterFact,
  type PeriodTaskCounterTask,
} from '../src/domain/progress/period-tasks.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';

function task(key: string, statusAtStart: string | null, entered: readonly string[]): PeriodTaskCounterTask {
  return { kind: PERIOD_TASK_COUNTER_TASK, key, statusAtStart, entered };
}

describe('счётчики задач отчёта за период', () => {
  it('INV-25 одинаковые факты дают одинаковые счётчики, порядок входа не меняет числа', () => {
    const facts: PeriodTaskCounterFact[] = [
      task('done', 'REVIEW', ['DONE']),
      { kind: PERIOD_TASK_COUNTER_COMMIT, key: 'sha-1' },
      task('born', null, ['IN_PROGRESS']),
      task('born-done', null, ['IN_PROGRESS', 'DONE']),
      { kind: PERIOD_TASK_COUNTER_ISSUE, key: 'issue-11', stateReason: 'completed' },
      task('drop', 'IN_PROGRESS', ['CANCELLED']),
      task('block', 'IN_PROGRESS', ['BLOCKED', 'IN_PROGRESS', 'BLOCKED']),
      { kind: PERIOD_TASK_COUNTER_ISSUE, key: 'issue-drop', stateReason: 'not_planned' },
    ];
    const forward = periodTaskCounters(facts);
    const backward = periodTaskCounters([...facts].reverse());
    expect(backward).toEqual(forward);
    expect(periodTaskCounters(facts)).toEqual(forward);
    expect(forward).toEqual({ confirmed: 2, created: 2, cancelled: 1, blocked: 1 });
  });

  it('INV-25 подтверждено — переход в DONE, уже DONE на начало не считается', () => {
    const report = periodTaskCounters([
      task('now', 'REVIEW', ['DONE']),
      task('again', 'IN_PROGRESS', ['REVIEW', 'DONE', 'DONE']),
      task('already', 'DONE', []),
      task('stayed', 'DONE', ['DONE']),
    ]);
    expect(report.confirmed).toBe(2);
  });

  it('INV-25 создано — задачи, которых на начало периода не было', () => {
    const report = periodTaskCounters([
      task('new', null, []),
      task('new-work', null, ['IN_PROGRESS']),
      task('old', 'IN_PROGRESS', []),
      task('old-done', 'PLANNED', ['IN_PROGRESS']),
    ]);
    expect(report.created).toBe(2);
    expect(report.confirmed).toBe(0);
  });

  it('INV-25 отменено — переход в CANCELLED, уже снятая на начало не считается без нового входа', () => {
    const report = periodTaskCounters([
      task('now', 'IN_PROGRESS', ['CANCELLED']),
      task('from-plan', 'PLANNED', ['CANCELLED']),
      task('already', 'CANCELLED', []),
      task('stayed', 'CANCELLED', ['CANCELLED']),
      task('twice', 'BLOCKED', ['CANCELLED', 'CANCELLED']),
    ]);
    expect(report.cancelled).toBe(3);
  });

  it('INV-25 встало в блок — первый вход в BLOCKED за период, уже BLOCKED на начало не входит', () => {
    const report = periodTaskCounters([
      task('fresh', 'IN_PROGRESS', ['BLOCKED']),
      task('flap', 'REVIEW', ['IN_PROGRESS', 'BLOCKED', 'IN_PROGRESS', 'BLOCKED']),
      task('born', null, ['IN_PROGRESS', 'BLOCKED']),
      task('already', 'BLOCKED', ['BLOCKED']),
      task('stays', 'BLOCKED', []),
      task('left', 'BLOCKED', ['IN_PROGRESS']),
    ]);
    expect(report.blocked).toBe(3);
    expect(report.created).toBe(1);
  });

  it('INV-25 закрытые issues и коммиты в счётчики задач не входят', () => {
    const tasksOnly = periodTaskCounters([task('done', 'REVIEW', ['DONE']), task('new', null, [])]);
    const mixed = periodTaskCounters([
      { kind: PERIOD_TASK_COUNTER_ISSUE, key: '11', stateReason: 'completed' },
      { kind: PERIOD_TASK_COUNTER_ISSUE, key: '12', stateReason: 'not_planned' },
      { kind: PERIOD_TASK_COUNTER_COMMIT, key: 'aaa' },
      { kind: PERIOD_TASK_COUNTER_COMMIT, key: 'bbb' },
      task('done', 'REVIEW', ['DONE']),
      task('new', null, []),
    ]);
    expect(mixed).toEqual(tasksOnly);
    expect(periodTaskCounters([{ kind: PERIOD_TASK_COUNTER_COMMIT, key: 'only' }])).toEqual({
      confirmed: 0,
      created: 0,
      cancelled: 0,
      blocked: 0,
    });
  });

  it('INV-25 пустой период — нули, не пропущенные поля', () => {
    expect(periodTaskCounters([])).toEqual({ confirmed: 0, created: 0, cancelled: 0, blocked: 0 });
  });

  it('битая задача периода в счётчики не попадает', () => {
    expect(() => periodTaskCounters([task(' ', 'IN_PROGRESS', [])])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_TASK_KEY }),
    );
    expect(() => periodTaskCounters([task('id', ' ', [])])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_TASK_STATUS }),
    );
    expect(() => periodTaskCounters([task('id', 'IN_PROGRESS', [' '])])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_TASK_STATUS }),
    );
    expect(() =>
      periodTaskCounters([task('id', 'IN_PROGRESS', ['DONE']), task('id', null, [])]),
    ).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_TASK_DUPLICATE }));
    expect(() => periodTaskCounters([{ kind: PERIOD_TASK_COUNTER_COMMIT, key: ' ' }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_FACT_KEY }),
    );
    expect(() => periodTaskCounters([{ kind: PERIOD_TASK_COUNTER_ISSUE, key: ' ' }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_FACT_KEY }),
    );
  });
});
