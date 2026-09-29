import { describe, expect, it } from 'vitest';
import { REPORT_NEXT_TASKS } from '../src/config/constants.ts';
import {
  REPORT_CURRENT_BRANCH_CI,
  REPORT_CURRENT_COMMIT,
  REPORT_CURRENT_ISSUE,
  REPORT_CURRENT_PULL_REQUEST,
  REPORT_CURRENT_TASK,
  reportCurrent,
  type ReportCurrentFact,
  type ReportCurrentTask,
} from '../src/domain/progress/report-current.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { BLOCKER_DEFAULT_BRANCH_CI, blockerPullRequestText } from '../src/projections/blockers-block.ts';
import { reportRiskLines, reportWorkLines } from '../src/projections/report-work-lines.ts';

const reason = 'нет стабильного доступа к одному из источников данных';

function task(patch: Partial<ReportCurrentTask> & Pick<ReportCurrentTask, 'key' | 'number' | 'title' | 'status'>): ReportCurrentTask {
  return {
    kind: REPORT_CURRENT_TASK,
    priority: 'normal',
    createdAt: '2026-09-01T00:00:00.000Z',
    day: 1,
    assigneeName: null,
    reason: null,
    ...patch,
  };
}

describe('Сейчас, Дальше и Риск отчёта', () => {
  it('INV-25 одинаковые факты дают одинаковый отчёт, порядок входа не меняет строки', () => {
    const facts: ReportCurrentFact[] = [
      task({
        key: 'later',
        number: 20,
        title: 'Позже',
        status: 'PLANNED',
        priority: 'low',
        createdAt: '2026-09-03T00:00:00.000Z',
      }),
      { kind: REPORT_CURRENT_ISSUE, key: 'issue-11', title: 'Telegram-интерфейс', stateReason: 'not_planned' },
      task({
        key: 'now',
        number: 7,
        title: 'Классификация сигнала',
        status: 'IN_PROGRESS',
        day: 3,
        assigneeName: 'Андрей',
      }),
      { kind: REPORT_CURRENT_COMMIT, key: 'sha-1' },
      task({
        key: 'blocked',
        number: 8,
        title: 'Доступ к источнику',
        status: 'BLOCKED',
        day: 3,
        assigneeName: 'Андрей',
        reason,
      }),
      { kind: REPORT_CURRENT_BRANCH_CI, key: 'ci' },
      {
        kind: REPORT_CURRENT_PULL_REQUEST,
        key: 'pr-138',
        pullRequestNumber: 138,
        ciRed: true,
      },
      task({ key: 'done', number: 3, title: 'Уже закрыта', status: 'DONE' }),
      task({
        key: 'plan',
        number: 14,
        title: 'Подготовить тестовые данные',
        status: 'PLANNED',
        priority: 'high',
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
    ];
    const forward = reportCurrent(facts);
    const backward = reportCurrent([...facts].reverse());
    expect(backward).toEqual(forward);
    expect(reportCurrent(facts)).toEqual(forward);
    const lines = reportWorkLines({ ...forward, showAssignee: true });
    expect(reportWorkLines({ ...backward, showAssignee: true })).toEqual(lines);
    const text = JSON.stringify(forward);
    expect(text).not.toContain('Telegram-интерфейс');
    expect(text).not.toContain('not_planned');
    expect(text).not.toContain('Уже закрыта');
    expect(text).not.toContain('sha-1');
  });

  it('R-734 Сейчас — IN_PROGRESS и BLOCKED', () => {
    const report = reportCurrent([
      task({ key: 'work', number: 7, title: 'Классификация сигнала', status: 'IN_PROGRESS' }),
      task({ key: 'blocked', number: 8, title: 'Ждёт доступ', status: 'BLOCKED', reason }),
      task({ key: 'plan', number: 14, title: 'Подготовить тестовые данные', status: 'PLANNED' }),
      task({ key: 'review', number: 9, title: 'На подтверждении', status: 'REVIEW' }),
      task({ key: 'done', number: 3, title: 'Закрытая задача', status: 'DONE' }),
      task({ key: 'drop', number: 4, title: 'Снятая задача', status: 'CANCELLED' }),
      { kind: REPORT_CURRENT_ISSUE, key: 'issue', title: 'Чужой issue', stateReason: 'completed' },
    ]);
    expect(report.now.map((item) => item.number)).toEqual([7, 8]);
    expect(report.now.map((item) => item.title)).toEqual(['Классификация сигнала', 'Ждёт доступ']);
    expect(report.next.map((item) => item.number)).toEqual([14]);
    const nowText = report.now.map((item) => item.title).join('\n');
    expect(nowText).not.toContain('Подготовить тестовые данные');
    expect(nowText).not.toContain('На подтверждении');
    expect(nowText).not.toContain('Закрытая задача');
    expect(nowText).not.toContain('Снятая задача');
    expect(nowText).not.toContain('Чужой issue');
  });

  it('R-738 Дальше — до трёх задач PLANNED, сначала больший приоритет, внутри него раньше созданная', () => {
    const report = reportCurrent([
      task({
        key: 'low',
        number: 30,
        title: 'Низкая',
        status: 'PLANNED',
        priority: 'low',
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      task({
        key: 'high-late',
        number: 12,
        title: 'Важная позже',
        status: 'PLANNED',
        priority: 'high',
        createdAt: '2026-09-04T00:00:00.000Z',
      }),
      task({
        key: 'normal',
        number: 15,
        title: 'Обычная',
        status: 'PLANNED',
        priority: 'normal',
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
      task({
        key: 'high-early',
        number: 14,
        title: 'Подготовить тестовые данные',
        status: 'PLANNED',
        priority: 'high',
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
      task({ key: 'work', number: 7, title: 'Классификация сигнала', status: 'IN_PROGRESS' }),
    ]);
    expect(REPORT_NEXT_TASKS).toBe(3);
    expect(report.next).toHaveLength(REPORT_NEXT_TASKS);
    expect(report.next.map((item) => item.title)).toEqual(['Подготовить тестовые данные', 'Важная позже', 'Обычная']);
    expect(report.next.map((item) => item.title)).not.toContain('Низкая');
    expect(report.next.map((item) => item.title)).not.toContain('Классификация сигнала');
  });

  it('R-743 Риск — причины блокеров и факты застоя дословно', () => {
    const report = reportCurrent([
      task({
        key: 'blocked',
        number: 7,
        title: 'Классификация сигнала',
        status: 'BLOCKED',
        reason: `  ${reason}  `,
      }),
      task({ key: 'silent', number: 8, title: 'Без ответа', status: 'BLOCKED', reason: '   ' }),
      task({ key: 'work', number: 9, title: 'В работе', status: 'IN_PROGRESS', reason: 'это не блокер' }),
      { kind: REPORT_CURRENT_BRANCH_CI, key: 'ci' },
      { kind: REPORT_CURRENT_PULL_REQUEST, key: 'pr-140', pullRequestNumber: 140, ciRed: false },
      { kind: REPORT_CURRENT_PULL_REQUEST, key: 'pr-138', pullRequestNumber: 138, ciRed: true },
      { kind: REPORT_CURRENT_ISSUE, key: 'quiet', title: 'Тихий issue', stateReason: 'not_planned' },
    ]);
    expect(report.reasons).toEqual([{ key: 'blocked', text: reason }]);
    expect(report.defaultBranchCiRed).toBe(true);
    expect(report.pullRequests).toEqual([
      { key: 'pr-138', pullRequestNumber: 138, ciRed: true },
      { key: 'pr-140', pullRequestNumber: 140, ciRed: false },
    ]);
    expect(reportRiskLines(report)).toEqual([
      `Риск: ${reason}`,
      `Риск: ${BLOCKER_DEFAULT_BRANCH_CI}`,
      `Риск: ${blockerPullRequestText({ pullRequestNumber: 138, ciRed: true })}`,
      `Риск: ${blockerPullRequestText({ pullRequestNumber: 140, ciRed: false })}`,
    ]);
    const text = reportRiskLines(report).join('\n');
    expect(text).not.toContain('7 —');
    expect(text).not.toContain('Тихий issue');
    expect(text).not.toContain('not_planned');
    expect(text).not.toContain('это не блокер');
    expect(text).not.toContain('Без ответа');
  });

  it('пустой id, повтор и пустой статус отклоняются', () => {
    expect(() => reportCurrent([task({ key: ' ', number: 1, title: 'А', status: 'IN_PROGRESS' })])).toThrow(DomainError);
    expect(() => reportCurrent([task({ key: ' ', number: 1, title: 'А', status: 'IN_PROGRESS' })])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REPORT_WORK_KEY }),
    );
    const again = task({ key: 'a', number: 1, title: 'А', status: 'IN_PROGRESS' });
    expect(() => reportCurrent([again, again])).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.REPORT_WORK_DUPLICATE }));
    expect(() => reportCurrent([task({ key: 'a', number: 1, title: 'А', status: ' ' })])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REPORT_WORK_STATUS }),
    );
  });
});
