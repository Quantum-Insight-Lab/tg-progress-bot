import { describe, expect, it } from 'vitest';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
  backlogShare,
  type BacklogIssue,
} from '../src/domain/progress/backlog-share.ts';
import {
  PERIOD_FACT_ISSUE,
  PERIOD_FACT_TASK,
  periodBacklog,
  type PeriodFact,
  type PeriodIssueFact,
} from '../src/domain/progress/period-backlog.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';

const openIssue: BacklogIssue = { state: BACKLOG_ISSUE_OPEN, stateReason: null };
const completedIssue: BacklogIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_COMPLETED };
const droppedIssue: BacklogIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_NOT_PLANNED };

function issue(
  key: string,
  number: number,
  title: string,
  atStart: BacklogIssue | null,
  atEnd: BacklogIssue | null,
): PeriodIssueFact {
  return { kind: PERIOD_FACT_ISSUE, key, number, title, atStart, atEnd };
}

function task(title: string, status: string): PeriodFact {
  return { kind: PERIOD_FACT_TASK, title, status };
}

describe('бэклог отчёта за период', () => {
  it('INV-25 одинаковые факты дают одинаковый отчёт, порядок входа не меняет строки', () => {
    const facts: PeriodFact[] = [
      issue('b', 20, 'Второй', openIssue, completedIssue),
      task('Закрытая задача', 'DONE'),
      issue('a', 11, 'Первый', null, openIssue),
      issue('c', 4, 'Уже был', completedIssue, completedIssue),
    ];
    const forward = periodBacklog(facts);
    const backward = periodBacklog([...facts].reverse());
    expect(backward).toEqual(forward);
    expect(periodBacklog(facts)).toEqual(forward);
  });

  it('INV-25 доля на начало и конец — формула раздела 4, остаток только на конец', () => {
    const stayedOpen = issue('open', 1, 'Открытый', openIssue, openIssue);
    const becameDone = issue('done', 2, 'Закрыли', openIssue, completedIssue);
    const dropped = issue('drop', 3, 'Сняли', openIssue, droppedIssue);
    const bornOpen = issue('new', 4, 'Новый', null, openIssue);
    const report = periodBacklog([stayedOpen, becameDone, dropped, bornOpen, task('День', 'DONE')]);
    const atStart = [openIssue, openIssue, openIssue];
    const atEnd = [openIssue, completedIssue, droppedIssue, openIssue];
    expect(report.shareAtStart).toEqual(backlogShare(atStart));
    expect(report.shareAtEnd).toEqual(backlogShare(atEnd));
    expect(report.remainderAtEnd).toEqual({
      remaining: report.shareAtEnd.remaining,
      total: report.shareAtEnd.remaining + report.shareAtEnd.completed,
    });
    expect(report.remainderAtEnd).not.toEqual({
      remaining: report.shareAtStart.remaining,
      total: report.shareAtStart.remaining + report.shareAtStart.completed,
    });
  });

  it('INV-25 отчёт не второй канвас: уже закрытые и давно открытые в строки периода не встают', () => {
    const report = periodBacklog([
      issue('old-done', 8, 'Архитектура', completedIssue, completedIssue),
      issue('old-open', 9, 'Долгий', openIssue, openIssue),
      issue('fresh-done', 11, 'Telegram-интерфейс', openIssue, completedIssue),
      issue('fresh-open', 12, 'Новая форма', null, openIssue),
    ]);
    expect(Object.keys(report).sort()).toEqual(['closed', 'openedNew', 'remainderAtEnd', 'shareAtEnd', 'shareAtStart']);
    expect(report.closed).toEqual([{ key: 'fresh-done', number: 11, title: 'Telegram-интерфейс' }]);
    expect(report.openedNew).toEqual([{ key: 'fresh-open', number: 12, title: 'Новая форма' }]);
    expect(report.shareAtEnd.completed).toBe(2);
  });

  it('INV-25 закрытые issues и задачи не смешиваются', () => {
    const report = periodBacklog([
      task('Telegram-интерфейс', 'DONE'),
      task('Снятая задача', 'CANCELLED'),
      issue('issue', 11, 'Telegram-интерфейс', openIssue, completedIssue),
    ]);
    expect(report.closed).toEqual([{ key: 'issue', number: 11, title: 'Telegram-интерфейс' }]);
    expect(report.openedNew).toEqual([]);
    expect(report.shareAtEnd).toEqual(backlogShare([completedIssue]));
  });

  it('INV-25 «Закрыто» — issues, ставшие completed, в том числе созданные уже закрытыми', () => {
    const report = periodBacklog([
      issue('was', 1, 'Уже сделан', completedIssue, completedIssue),
      issue('now', 3, 'Стал', openIssue, completedIssue),
      issue('born', 2, 'Сразу закрыт', null, completedIssue),
      issue('reopened', 4, 'Снова открыт', completedIssue, openIssue),
    ]);
    expect(report.closed.map((line) => line.number)).toEqual([2, 3]);
  });

  it('INV-25 «Открыто новых» — созданные за период и всё ещё открытые', () => {
    const report = periodBacklog([
      issue('still', 5, 'Ещё открыт', null, openIssue),
      issue('closed-new', 6, 'Успели закрыть', null, completedIssue),
      issue('old', 1, 'Был открыт', openIssue, openIssue),
      issue('dropped-new', 7, 'Сняли новый', null, droppedIssue),
    ]);
    expect(report.openedNew).toEqual([{ key: 'still', number: 5, title: 'Ещё открыт' }]);
    expect(report.closed.map((line) => line.key)).toEqual(['closed-new']);
  });

  it('INV-25 not_planned в строки бэклога не входит и долю не двигает', () => {
    const kept = [
      issue('open', 1, 'Открытый', openIssue, openIssue),
      issue('done', 2, 'Сделанный', completedIssue, completedIssue),
    ];
    const withDropped = [
      ...kept,
      issue('old-drop', 3, 'Давно снят', droppedIssue, droppedIssue),
      issue('born-drop', 5, 'Создали снятым', null, droppedIssue),
    ];
    const plain = periodBacklog(kept);
    const dropped = periodBacklog(withDropped);
    expect(dropped.shareAtStart).toEqual(plain.shareAtStart);
    expect(dropped.shareAtEnd).toEqual(plain.shareAtEnd);
    expect(dropped.closed).toEqual([]);
    expect(dropped.openedNew).toEqual([]);
    expect(dropped.remainderAtEnd).toEqual(plain.remainderAtEnd);

    const left = periodBacklog([
      issue('open', 1, 'Открытый', openIssue, openIssue),
      issue('left', 8, 'Ушёл', openIssue, droppedIssue),
    ]);
    expect(left.closed).toEqual([]);
    expect(left.openedNew).toEqual([]);
    expect(left.shareAtStart).toEqual(backlogShare([openIssue, openIssue]));
    expect(left.shareAtEnd).toEqual(backlogShare([openIssue]));
  });

  it('INV-25 пустой период — нет доли и нет остатка, не ноль', () => {
    const report = periodBacklog([task('Пустая задача', 'DONE'), issue('gone', 1, 'Снят', null, droppedIssue)]);
    expect(report.shareAtStart).toEqual(backlogShare([]));
    expect(report.shareAtEnd).toEqual(backlogShare([droppedIssue]));
    expect(report.shareAtEnd.ratio).toBeNull();
    expect(report.remainderAtEnd).toBeNull();
    expect(report.closed).toEqual([]);
    expect(report.openedNew).toEqual([]);
  });

  it('битый issue периода в отчёт не попадает', () => {
    expect(() => periodBacklog([issue(' ', 1, 'Имя', openIssue, openIssue)])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ID_BLANK }),
    );
    expect(() => periodBacklog([issue('id', 0, 'Имя', openIssue, openIssue)])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_NUMBER }),
    );
    expect(() => periodBacklog([issue('id', 1, ' ', openIssue, openIssue)])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_TITLE_BLANK }),
    );
    expect(() => periodBacklog([issue('id', 1, 'Имя', null, null)])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_ISSUE_SPAN }),
    );
    expect(() =>
      periodBacklog([
        issue('id', 1, 'Имя', openIssue, openIssue),
        issue('id', 2, 'Другое', openIssue, completedIssue),
      ]),
    ).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.PERIOD_ISSUE_DUPLICATE }));
    expect(() => periodBacklog([issue('id', 1, 'Имя', { state: 'DONE', stateReason: null }, openIssue)])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE }),
    );
  });
});
