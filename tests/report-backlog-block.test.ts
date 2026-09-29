import { describe, expect, it } from 'vitest';
import { REPORT_LIST_LIMIT } from '../src/config/constants.ts';
import {
  reportProjectBacklogLines,
  type ReportBacklogIssue,
  type ReportProjectBacklogView,
} from '../src/projections/report-backlog-block.ts';

const sensor: ReportProjectBacklogView = {
  projectName: 'Общественный сенсор',
  shareAtStart: { completed: 13, remaining: 18, ratio: 13 / 31 },
  shareAtEnd: { completed: 14, remaining: 17, ratio: 14 / 31 },
  remainderAtEnd: { remaining: 17, total: 31 },
  closed: [{ number: 11, title: 'Telegram-интерфейс' }],
  openedNew: [{ number: 12, title: 'Новая форма' }],
  confirmedOn: [],
};

const block = [
  'Общественный сенсор',
  'Бэклог: 42% → 45% · осталось 17 из 31',
  'Закрыто: #11 Telegram-интерфейс',
  'Открыто новых: 1',
].join('\n');

function named(count: number): ReportBacklogIssue[] {
  const issues: ReportBacklogIssue[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = index + 1;
    issues.push({ number, title: `пункт ${String(number)}` });
  }
  return issues;
}

function issueLabel(issue: ReportBacklogIssue): string {
  return `#${String(issue.number)} ${issue.title}`;
}

function closedText(closed: readonly ReportBacklogIssue[]): string {
  const line = reportProjectBacklogLines({ ...sensor, closed, openedNew: [] }).find((item) => item.startsWith('Закрыто:'));
  if (line === undefined) throw new Error('строки «Закрыто» нет');
  return line;
}

describe('строки бэклога в блоке проекта', () => {
  it('R-668 «Общественный сенсор»', () => {
    const lines = reportProjectBacklogLines(sensor);
    expect(lines[0]).toBe('Общественный сенсор');
    expect(lines.join('\n')).toBe(block);
  });

  it('R-669 «Бэклог»', () => {
    expect(reportProjectBacklogLines(sensor).join('\n')).toContain('Бэклог: ');
  });

  it('R-670 «42% → 45%»', () => {
    expect(reportProjectBacklogLines(sensor).join('\n')).toContain('42% → 45%');
  });

  it('R-671 «осталось 17 из 31»', () => {
    expect(reportProjectBacklogLines(sensor).join('\n')).toContain('осталось 17 из 31');
  });

  it('R-672 «Закрыто: #11 Telegram-интерфейс»', () => {
    expect(reportProjectBacklogLines(sensor).join('\n')).toContain('Закрыто: #11 Telegram-интерфейс');
  });

  it('R-673 «Открыто новых: 1»', () => {
    const text = reportProjectBacklogLines(sensor).join('\n');
    expect(text).toContain('Открыто новых: 1');
    expect(text).not.toContain('Новая форма');
  });

  it('R-511 Дата подтверждения остаётся в отчёте', () => {
    const text = reportProjectBacklogLines({ ...sensor, confirmedOn: ['2026-09-17', '2026-09-17'] }).join('\n');
    expect(text).toContain('17.09');
    expect(text).not.toContain('17.09 · 17.09');
    expect(text.startsWith('Общественный сенсор\n')).toBe(true);
    expect(text).toContain('Бэклог: 42% → 45% · осталось 17 из 31');
    expect(text).not.toContain('на подтверждении');
    const later = reportProjectBacklogLines({
      ...sensor,
      confirmedOn: ['2026-09-17', '2026-09-18'],
    }).join('\n');
    expect(later).toContain('17.09 · 18.09');
  });

  it('R-749 Нет данных — строка не печатается', () => {
    const text = reportProjectBacklogLines({
      ...sensor,
      shareAtStart: { completed: 0, remaining: 0, ratio: null },
      shareAtEnd: { completed: 0, remaining: 0, ratio: null },
      remainderAtEnd: null,
      closed: [],
      openedNew: [],
    }).join('\n');
    expect(text).toBe('Общественный сенсор');
    expect(text).not.toContain('Нет данных');
    expect(text).not.toContain('Бэклог');
    expect(text).not.toContain('0%');
    expect(text).not.toContain('Закрыто');
    expect(text).not.toContain('Открыто новых');
  });

  it('R-751 Списки длиннее пяти пунктов не вываливаются', () => {
    const overflow = REPORT_LIST_LIMIT + 3;
    const closed = named(overflow);
    const line = closedText(closed);
    expect(line).not.toBe(`Закрыто: ${closed.map(issueLabel).join(', ')}`);
    for (const issue of closed.slice(REPORT_LIST_LIMIT)) {
      expect(line).not.toContain(issueLabel(issue));
    }
    const exact = closedText(named(REPORT_LIST_LIMIT));
    expect(exact.startsWith('Закрыто: #')).toBe(true);
    expect(exact).not.toContain('среди них');
  });

  it('R-752 печатается число и до пяти названий', () => {
    const closed = named(REPORT_LIST_LIMIT + 3);
    const shown = closed.slice(0, REPORT_LIST_LIMIT).map(issueLabel).join(', ');
    expect(closedText(closed)).toBe(`Закрыто: ${String(closed.length)}, среди них ${shown}`);
  });

  it('пустая доля не становится нулём, ноль доли печатается', () => {
    const empty = reportProjectBacklogLines({
      ...sensor,
      shareAtStart: { completed: 0, remaining: 0, ratio: null },
      shareAtEnd: { completed: 0, remaining: 0, ratio: null },
      remainderAtEnd: null,
      closed: [],
      openedNew: [],
    });
    expect(empty).toEqual(['Общественный сенсор']);
    expect(empty.join('\n')).not.toContain('0%');
    expect(empty.join('\n')).not.toContain('Бэклог');
    expect(empty.join('\n')).not.toContain('Закрыто');
    expect(empty.join('\n')).not.toContain('Открыто новых');

    const zero = reportProjectBacklogLines({
      ...sensor,
      shareAtStart: { completed: 0, remaining: 31, ratio: 0 },
      openedNew: [],
      closed: [],
    });
    expect(zero.join('\n')).toContain('0% → 45% · осталось 17 из 31');
  });

  it('несколько закрытых печатаются через запятую, пустое имя и кривая дата — нет', () => {
    const two = reportProjectBacklogLines({
      ...sensor,
      closed: [
        { number: 11, title: 'Telegram-интерфейс' },
        { number: 4, title: 'архитектура проекта' },
      ],
      openedNew: [],
    });
    expect(two.join('\n')).toContain('Закрыто: #11 Telegram-интерфейс, #4 архитектура проекта');
    expect(two.join('\n')).not.toContain('Открыто новых');
    expect(() => reportProjectBacklogLines({ ...sensor, projectName: '  ' })).toThrow('у блока проекта есть имя');
    expect(() => reportProjectBacklogLines({ ...sensor, confirmedOn: ['17.09'] })).toThrow(
      'дата подтверждения — календарный день',
    );
    expect(() =>
      reportProjectBacklogLines({
        ...sensor,
        closed: [{ number: 11, title: '  ' }],
      }),
    ).toThrow('у issue отчёта есть название');
  });
});
