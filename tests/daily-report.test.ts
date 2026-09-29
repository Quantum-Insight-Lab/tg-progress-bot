import { describe, expect, it } from 'vitest';
import { overallBacklogShare, type IssueRow, type ProjectMemberSlice } from '../src/domain/progress/repository-share.ts';
import { DIVERGENCE_LINE } from '../src/projections/divergence-line.ts';
import {
  dailyReport,
  type DailyReportProject,
  type DailyReportView,
} from '../src/projections/daily-report.ts';
import type { ReportProjectBacklogView } from '../src/projections/report-backlog-block.ts';

const sensorBacklog: ReportProjectBacklogView = {
  projectName: 'Общественный сенсор',
  shareAtStart: { completed: 13, remaining: 18, ratio: 13 / 31 },
  shareAtEnd: { completed: 14, remaining: 17, ratio: 14 / 31 },
  remainderAtEnd: { remaining: 17, total: 31 },
  closed: [{ number: 11, title: 'Telegram-интерфейс' }],
  openedNew: [{ number: 12, title: 'Новая форма' }],
  confirmedOn: [],
};

const archiveBacklog: ReportProjectBacklogView = {
  projectName: 'Полевой архив',
  shareAtStart: { completed: 12, remaining: 24, ratio: 12 / 36 },
  shareAtEnd: { completed: 12, remaining: 24, ratio: 12 / 36 },
  remainderAtEnd: { remaining: 24, total: 36 },
  closed: [],
  openedNew: [],
  confirmedOn: [],
};

const quietTasks = { confirmed: 0, created: 0, cancelled: 0, blocked: 0 };

const emptyRisk = { reasons: [], defaultBranchCiRed: false, pullRequests: [] };

function project(
  backlog: ReportProjectBacklogView,
  memberIds: readonly string[],
  extra: Partial<Pick<DailyReportProject, 'tasks' | 'now' | 'next' | 'risk' | 'divergence'>> = {},
): DailyReportProject {
  return {
    memberIds,
    backlog,
    tasks: extra.tasks ?? quietTasks,
    now: extra.now ?? [],
    next: extra.next ?? [],
    risk: extra.risk ?? emptyRisk,
    divergence: extra.divergence ?? false,
  };
}

const sensor = project(sensorBacklog, ['ann'], {
  tasks: { confirmed: 1, created: 2, cancelled: 0, blocked: 1 },
  now: [{ number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей' }],
  next: [{ number: 14, title: 'Подготовить тестовые данные' }],
  risk: {
    reasons: [{ text: 'нет стабильного доступа к одному из источников данных' }],
    defaultBranchCiRed: false,
    pullRequests: [],
  },
});

const archive = project(archiveBacklog, ['boris']);

const overall = {
  shareAtStart: { completed: 25, remaining: 42, ratio: 25 / 67 },
  shareAtEnd: { completed: 26, remaining: 41, ratio: 26 / 67 },
  remainderAtEnd: { remaining: 41, total: 67 },
};

function view(audience: DailyReportView['audience'], memberId: string | null, projects: readonly DailyReportProject[]): DailyReportView {
  return { date: '2026-09-17', audience, memberId, ...overall, projects };
}

const teamText = [
  'За сутки · 17.09',
  'Все проекты: 37% → 39% · осталось 41 из 67',
  '',
  'Общественный сенсор',
  'Бэклог: 42% → 45% · осталось 17 из 31',
  'Закрыто: #11 Telegram-интерфейс',
  'Открыто новых: 1',
  'Задачи: подтверждено 1 · создано 2 · отменено 0 · встало в блок 1',
  'Сейчас: 7 — Классификация сигнала — Андрей, 3-й день',
  'Дальше: 14 — Подготовить тестовые данные',
  'Риск: нет стабильного доступа к одному из источников данных',
].join('\n');

describe('ежедневный отчёт', () => {
  it('R-654 «Отчёт — что изменилось за сутки»', () => {
    const text = dailyReport(view('team', null, [sensor]));
    expect(text).toBe(teamText);
    expect(text.startsWith('За сутки · 17.09')).toBe(true);
    expect(text).toContain(' → ');
    expect(text).not.toContain('ПРОЕКТ:');
    expect(text).not.toContain('Сделано по проекту');
  });

  it('R-663 «За сутки»', () => {
    expect(dailyReport(view('team', null, [sensor])).startsWith('За сутки · ')).toBe(true);
  });

  it('R-664 «17.09»', () => {
    const text = dailyReport(view('dm', 'ann', [sensor]));
    expect(text.startsWith('За сутки · 17.09\n')).toBe(true);
    expect(text).not.toContain('2026-09-17');
  });

  it('R-665 «Все проекты»', () => {
    expect(dailyReport(view('team', null, [sensor]))).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
  });

  it('R-666 «37% → 39%»', () => {
    const text = dailyReport(view('team', null, [sensor, archive]));
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
    expect(text).toContain('Бэклог: 42% → 45% · осталось 17 из 31');
    expect(text).toContain('Бэклог: 33% → 33% · осталось 24 из 36');
  });

  it('R-667 «осталось 41 из 67»', () => {
    expect(dailyReport(view('team', null, [sensor]))).toContain('осталось 41 из 67');
  });

  it('R-658 «В личке — проекты этого человека»', () => {
    const text = dailyReport(view('dm', 'ann', [sensor, archive]));
    expect(text).toContain('Общественный сенсор');
    expect(text).not.toContain('Полевой архив');
    expect(text).toContain('Сейчас: 7 — Классификация сигнала, 3-й день');
    expect(text).not.toContain('Андрей');
  });

  it('R-463 Строка «все проекты» есть и в личке', () => {
    const text = dailyReport(view('dm', 'ann', [sensor]));
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
  });

  it('R-464 и в командном топике', () => {
    const text = dailyReport(view('team', null, [sensor, archive]));
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
  });

  it('R-171 блоком на каждый её проект', () => {
    const draft = project(
      { ...archiveBacklog, projectName: 'Черновик', closed: [], openedNew: [] },
      [],
    );
    const text = dailyReport(view('team', null, [sensor, archive, draft]));
    const sensorAt = text.indexOf('Общественный сенсор');
    const archiveAt = text.indexOf('Полевой архив');
    const draftAt = text.indexOf('Черновик');
    expect(sensorAt).toBeGreaterThan(0);
    expect(archiveAt).toBeGreaterThan(sensorAt);
    expect(draftAt).toBeGreaterThan(archiveAt);
    expect(text.split('\n\n')).toHaveLength(4);
  });

  it('INV-25 одинаковые факты дают одинаковый отчёт, пустая доля не становится нулём', () => {
    const report = view('team', null, [sensor, archive]);
    expect(dailyReport(report)).toBe(dailyReport(report));
    expect(dailyReport({ ...report, projects: [archive, sensor] })).toContain('Полевой архив');

    const empty = dailyReport({
      ...report,
      shareAtStart: { completed: 0, remaining: 0, ratio: null },
      shareAtEnd: { completed: 0, remaining: 0, ratio: null },
      remainderAtEnd: null,
    });
    expect(empty.startsWith('За сутки · 17.09\n\nОбщественный сенсор')).toBe(true);
    expect(empty).not.toContain('Все проекты');
    expect(empty).not.toContain('0%');
    expect(empty).not.toContain('Нет данных');

    const zero = dailyReport({
      ...view('dm', 'ann', [sensor]),
      shareAtStart: { completed: 0, remaining: 67, ratio: 0 },
    });
    expect(zero).toContain('Все проекты: 0% → 39% · осталось 41 из 67');
  });

  it('INV-25 строка «Все проекты» — формула доли по репозиториям, не среднее карточек', () => {
    const repoA = '11';
    const repoB = '22';
    const slices: ProjectMemberSlice[] = [
      { projectId: 'sensor', repositoryId: repoA, memberKeys: ['ann'] },
      { projectId: 'archive', repositoryId: repoB, memberKeys: [] },
      { projectId: 'bare', repositoryId: null, memberKeys: [] },
    ];
    const pack = (repositoryId: string, openCount: number, completedCount: number, from: number): IssueRow[] => {
      const rows: IssueRow[] = [];
      for (let index = 0; index < openCount; index += 1) {
        rows.push({ repositoryId, issueNumber: from + index, state: 'open', stateReason: null });
      }
      for (let index = 0; index < completedCount; index += 1) {
        rows.push({
          repositoryId,
          issueNumber: from + openCount + index,
          state: 'closed',
          stateReason: 'completed',
        });
      }
      return rows;
    };
    const dropped: IssueRow = { repositoryId: repoA, issueNumber: 900, state: 'closed', stateReason: 'not_planned' };
    const startIssues = [...pack(repoA, 18, 13, 1), ...pack(repoB, 24, 12, 100), dropped];
    const endIssues = [...pack(repoA, 17, 14, 1), ...pack(repoB, 24, 12, 100), dropped];
    const shareAtStart = overallBacklogShare(slices, startIssues);
    const shareAtEnd = overallBacklogShare(slices, endIssues);
    expect(shareAtStart).toEqual({ completed: 25, remaining: 42, ratio: 25 / 67 });
    expect(shareAtEnd).toEqual({ completed: 26, remaining: 41, ratio: 26 / 67 });

    const text = dailyReport({
      ...view('team', null, [sensor, archive]),
      shareAtStart,
      shareAtEnd,
      remainderAtEnd: { remaining: shareAtEnd.remaining, total: shareAtEnd.remaining + shareAtEnd.completed },
    });
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
    expect(text).toContain('Бэклог: 42% → 45%');
    expect(dailyReport({ ...view('team', null, [sensor, archive]), shareAtStart, shareAtEnd, remainderAtEnd: { remaining: 41, total: 67 } })).toBe(text);
  });

  it('INV-26 в личке проекты человека, в командном топике все проекты одним текстом', () => {
    const catalog = [sensor, archive];
    const dm = dailyReport(view('dm', ' ann ', catalog));
    const team = dailyReport(view('team', 'ann', catalog));
    expect(dm).toContain('Общественный сенсор');
    expect(dm).not.toContain('Полевой архив');
    expect(dm).not.toContain('Андрей');
    expect(team).toContain('Общественный сенсор');
    expect(team).toContain('Полевой архив');
    expect(team).toContain('— Андрей');
    expect(dm).toContain('Все проекты:');
    expect(team).toContain('Все проекты:');
    expect(typeof dm).toBe('string');
    expect(typeof team).toBe('string');
    expect(() => dailyReport({ ...view('team', null, catalog), audience: 'topic' as 'team' })).toThrow(
      'отчёт за сутки — личка или командный топик',
    );
  });

  it('расхождение стоит в блоке своего проекта, кривые дата и адресат — нет', () => {
    const loud = project(sensorBacklog, ['ann'], { divergence: true });
    const text = dailyReport(view('team', null, [loud, archive]));
    expect(text).toContain(`Общественный сенсор\nБэклог: 42% → 45% · осталось 17 из 31`);
    expect(text).toContain(DIVERGENCE_LINE);
    const archiveBlock = text.slice(text.indexOf('Полевой архив'));
    expect(archiveBlock).not.toContain(DIVERGENCE_LINE);
    expect(() => dailyReport({ ...view('team', null, [sensor]), date: '17.09' })).toThrow('дата отчёта — календарный день');
    expect(() => dailyReport(view('dm', '  ', [sensor]))).toThrow('личный отчёт адресован человеку');
    expect(() => dailyReport(view('dm', null, [sensor]))).toThrow('личный отчёт адресован человеку');
    expect(() => dailyReport(view('team', null, [project(sensorBacklog, [' '])]))).toThrow('у участника проекта есть id');
  });
});
