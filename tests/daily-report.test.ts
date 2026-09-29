import { describe, expect, it } from 'vitest';
import { overallBacklogShare, type IssueRow, type ProjectMemberSlice } from '../src/domain/progress/repository-share.ts';
import { DIVERGENCE_LINE } from '../src/projections/divergence-line.ts';
import {
  dailyReport,
  reportReadings,
  type DailyReportProject,
  type DailyReportView,
  type ReportRepositoryFacts,
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
  extra: Partial<Pick<DailyReportProject, 'chatId' | 'tasks' | 'now' | 'next' | 'risk' | 'divergence' | 'repository'>> = {},
): DailyReportProject {
  return {
    chatId: extra.chatId ?? 'group',
    memberIds,
    backlog,
    tasks: extra.tasks ?? quietTasks,
    now: extra.now ?? [],
    next: extra.next ?? [],
    risk: extra.risk ?? emptyRisk,
    divergence: extra.divergence ?? false,
    repository: extra.repository ?? null,
  };
}

const sensor = project(sensorBacklog, ['ann'], {
  tasks: { confirmed: 1, created: 2, cancelled: 0, blocked: 1 },
  now: [{ number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей', assigneeId: 'ann' }],
  next: [{ number: 14, title: 'Подготовить тестовые данные', assigneeId: 'ann' }],
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
  return { chatId: 'group', date: '2026-09-17', audience, memberId, ...overall, projects };
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
    expect(() => dailyReport({ ...view('team', null, [sensor]), chatId: ' ' })).toThrow('у отчёта есть чат');
    expect(() =>
      dailyReport(view('team', null, [project(sensorBacklog, ['ann'], { now: [{ number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей', assigneeId: ' ' }] })])),
    ).toThrow('у задачи отчёта есть исполнитель');
  });
});

const sensorRepo: ReportRepositoryFacts = {
  repositoryId: '11',
  slug: 'org/sensor',
  ci: 'success',
  commits: 6,
  mergedPullRequests: 1,
  closedIssueTitles: ['Не для блока репозитория'],
};

const archiveRepo: ReportRepositoryFacts = {
  repositoryId: '22',
  slug: 'org/archive',
  ci: 'success',
  commits: 4,
  mergedPullRequests: 2,
  closedIssueTitles: [],
};

function githubBlock(slug: string, facts: string, projects: string): string {
  return [`GitHub ${slug}`, facts, `Проекты: ${projects}`].join('\n');
}

describe('состав отчёта по чату', () => {
  it('R-170 Отчёт в командный топик группы уходит один', () => {
    const text = dailyReport(view('team', null, [sensor, archive]));
    expect(text.match(/За сутки/g)).toHaveLength(1);
    const readings = reportReadings({
      memberIds: ['ann', 'boris', 'ann'],
      commandTopicId: 10,
      executorTopicIds: [21, 22],
    });
    expect(readings.filter((item) => item.place === 'team')).toEqual([
      { place: 'team', memberId: null, threadId: 10 },
    ]);
  });

  it('R-659 В командный топик тем же составом уходят сразу все проекты этого чата', () => {
    const foreign = project({ ...archiveBacklog, projectName: 'Чужой чат' }, ['ann'], { chatId: 'elsewhere' });
    const text = dailyReport(view('team', null, [sensor, archive, foreign]));
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
    expect(text).toContain('Общественный сенсор');
    expect(text).toContain('Полевой архив');
    expect(text).not.toContain('Чужой чат');
    expect(text.match(/За сутки/g)).toHaveLength(1);
  });

  it('R-662 Топики исполнителей отчёт не получают', () => {
    const readings = reportReadings({
      memberIds: ['ann', 'boris'],
      commandTopicId: 10,
      executorTopicIds: [21, 22],
    });
    expect(readings.map((item) => item.threadId)).toEqual([10, null, null]);
    expect(readings.some((item) => item.threadId === 21 || item.threadId === 22)).toBe(false);
    expect(() => reportReadings({ memberIds: ['ann'], commandTopicId: 21, executorTopicIds: [21] })).toThrow(
      'топик исполнителя отчёт не получает',
    );
  });

  it('R-690 В личном отчёте «Сейчас» и «Дальше» — задачи этого человека', () => {
    const shared = project(sensorBacklog, ['ann', 'boris'], {
      tasks: sensor.tasks,
      now: [
        { number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей', assigneeId: 'ann' },
        { number: 8, title: 'Сбор поля', day: 2, assigneeName: 'Борис', assigneeId: 'boris' },
      ],
      next: [
        { number: 14, title: 'Подготовить тестовые данные', assigneeId: 'ann' },
        { number: 15, title: 'Разобрать архив', assigneeId: 'boris' },
        { number: 16, title: 'Первый запас', assigneeId: 'ann' },
        { number: 17, title: 'Второй запас', assigneeId: 'ann' },
        { number: 18, title: 'Третий запас', assigneeId: 'ann' },
      ],
    });
    const text = dailyReport(view('dm', 'ann', [shared, archive]));
    expect(text).toContain('Сейчас: 7 — Классификация сигнала, 3-й день');
    expect(text).toContain('Дальше: 14 — Подготовить тестовые данные');
    expect(text).toContain('Дальше: 16 — Первый запас');
    expect(text).toContain('Дальше: 17 — Второй запас');
    expect(text).not.toContain('Дальше: 18');
    expect(text).not.toContain('Сбор поля');
    expect(text).not.toContain('Разобрать архив');
    expect(text).not.toContain('Борис');
    expect(text).not.toContain('Андрей');
  });

  it('R-691 В командном топике — задачи всех участников этих проектов', () => {
    const shared = project(sensorBacklog, ['ann', 'boris'], {
      tasks: sensor.tasks,
      now: [
        { number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей', assigneeId: 'ann' },
        { number: 8, title: 'Сбор поля', day: 2, assigneeName: 'Борис', assigneeId: 'boris' },
      ],
      next: [
        { number: 14, title: 'Подготовить тестовые данные', assigneeId: 'ann' },
        { number: 15, title: 'Разобрать архив', assigneeId: 'boris' },
      ],
    });
    const text = dailyReport(view('team', null, [shared]));
    expect(text).toContain('Сейчас: 7 — Классификация сигнала — Андрей, 3-й день');
    expect(text).toContain('Сейчас: 8 — Сбор поля — Борис, 2-й день');
    expect(text).toContain('Дальше: 14 — Подготовить тестовые данные');
    expect(text).toContain('Дальше: 15 — Разобрать архив');
  });

  it('R-753 Отчёт читают в двух местах', () => {
    const readings = reportReadings({ memberIds: ['ann'], commandTopicId: 10, executorTopicIds: [21] });
    expect(readings.map((item) => item.place)).toEqual(['team', 'dm']);
    expect(readings.find((item) => item.place === 'dm')).toEqual({ place: 'dm', memberId: 'ann', threadId: null });
    expect(readings.find((item) => item.place === 'team')?.threadId).toBe(10);
  });

  it('R-756 и блоки их репозиториев', () => {
    const own = project(sensorBacklog, ['ann'], { repository: sensorRepo, tasks: sensor.tasks, now: sensor.now, next: sensor.next });
    const other = project(archiveBacklog, ['boris'], { repository: archiveRepo });
    const text = dailyReport(view('dm', 'ann', [own, other]));
    expect(text).toContain('Общественный сенсор');
    expect(text).toContain(githubBlock('org/sensor', 'CI зелёный · смержено PR 1 · коммитов 6', 'Общественный сенсор'));
    expect(text).not.toContain('org/archive');
    expect(text).not.toContain('Не для блока репозитория');
    expect(text).not.toContain('Полевой архив');
  });

  it('R-721 и в сумму по проектам не складываются', () => {
    const first = project(sensorBacklog, ['ann'], { repository: sensorRepo });
    const second = project(archiveBacklog, ['ann'], { repository: archiveRepo });
    const separate = dailyReport(view('dm', 'ann', [first, second]));
    expect(separate.split('\n\n').filter((part) => part.startsWith('GitHub '))).toEqual([
      githubBlock('org/sensor', 'CI зелёный · смержено PR 1 · коммитов 6', 'Общественный сенсор'),
      githubBlock('org/archive', 'CI зелёный · смержено PR 2 · коммитов 4', 'Полевой архив'),
    ]);
    expect(separate).not.toContain('коммитов 10');
    expect(separate).not.toContain('смержено PR 3');

    const twin = project({ ...archiveBacklog, projectName: 'Второе имя' }, ['ann'], { repository: sensorRepo });
    const shared = dailyReport(view('team', null, [first, twin]));
    expect(shared.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(shared).toContain('Проекты: Общественный сенсор, Второе имя');
    expect(shared).not.toContain('коммитов 12');
    expect(shared).not.toContain('смержено PR 2');
    expect(() =>
      dailyReport(
        view('team', null, [first, project(archiveBacklog, ['ann'], { repository: { ...sensorRepo, commits: 7 } })]),
      ),
    ).toThrow('коммиты и PR репозитория по проектам не складываются');
  });

  it('INV-26 в личке задачи человека и один блок репозитория, в командном топике все проекты чата', () => {
    const own = project(sensorBacklog, ['ann', 'boris'], {
      tasks: sensor.tasks,
      now: [
        { number: 7, title: 'Классификация сигнала', day: 3, assigneeName: 'Андрей', assigneeId: 'ann' },
        { number: 8, title: 'Сбор поля', day: 2, assigneeName: 'Борис', assigneeId: 'boris' },
      ],
      next: sensor.next,
      repository: sensorRepo,
    });
    const twin = project({ ...archiveBacklog, projectName: 'Второй проект' }, ['boris'], {
      repository: sensorRepo,
    });
    const foreign = project({ ...archiveBacklog, projectName: 'Чужой чат' }, ['ann'], {
      chatId: 'elsewhere',
      repository: archiveRepo,
    });
    const dm = dailyReport(view('dm', 'ann', [own, twin, foreign]));
    const team = dailyReport(view('team', null, [own, twin, foreign]));
    expect(dm).toContain('Общественный сенсор');
    expect(dm).not.toContain('Второй проект');
    expect(dm).not.toContain('Чужой чат');
    expect(dm).not.toContain('Сбор поля');
    expect(dm).toContain('Классификация сигнала');
    expect(dm.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(dm).toContain('Проекты: Общественный сенсор');
    expect(dm).not.toContain('Проекты: Общественный сенсор,');
    expect(dm).not.toContain('Не для блока репозитория');
    expect(dm).not.toContain('org/archive');
    expect(team).toContain('Общественный сенсор');
    expect(team).toContain('Второй проект');
    expect(team).not.toContain('Чужой чат');
    expect(team).toContain('Сбор поля');
    expect(team).toContain('— Борис');
    expect(team.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(team).toContain('Проекты: Общественный сенсор, Второй проект');
    expect(team).not.toContain('коммитов 12');
    const readings = reportReadings({ memberIds: ['ann', 'boris'], commandTopicId: 10, executorTopicIds: [21] });
    expect(readings.map((item) => item.place)).toEqual(['team', 'dm', 'dm']);
    expect(readings.some((item) => item.threadId === 21)).toBe(false);
  });

  it('INV-01 коммиты и PR не входят в строку «Все проекты»', () => {
    const loud = project(sensorBacklog, ['ann'], { repository: { ...sensorRepo, commits: 40, mergedPullRequests: 9 } });
    const text = dailyReport(view('team', null, [loud, archive]));
    expect(text).toContain('Все проекты: 37% → 39% · осталось 41 из 67');
    expect(text).toContain('коммитов 40');
    expect(text).not.toContain('Все проекты: 40');
    expect(text).not.toContain('коммитов 49');
  });
});

describe('блок GitHub в отчёте', () => {
  const sensorGithub = githubBlock('org/sensor', 'CI зелёный · смержено PR 1 · коммитов 6', 'Общественный сенсор');

  it('R-684 «GitHub org/sensor»', () => {
    const text = dailyReport(view('team', null, [project(sensorBacklog, ['ann'], { repository: sensorRepo })]));
    expect(text).toContain(sensorGithub);
    expect(text.indexOf('Общественный сенсор')).toBeLessThan(text.indexOf('GitHub org/sensor'));
  });

  it('R-693 «Блок GitHub один на репозиторий»', () => {
    const first = project(sensorBacklog, ['ann'], { repository: sensorRepo });
    const second = project(archiveBacklog, ['ann'], { repository: archiveRepo });
    const twin = project({ ...archiveBacklog, projectName: 'Второе имя' }, ['ann'], { repository: sensorRepo });
    const two = dailyReport(view('team', null, [first, second]));
    expect(two.match(/GitHub /g)).toHaveLength(2);
    const one = dailyReport(view('team', null, [first, twin]));
    expect(one.match(/GitHub /g)).toHaveLength(1);
  });

  it('R-694 даже если им пользуются два проекта', () => {
    const first = project(sensorBacklog, ['ann'], { repository: sensorRepo });
    const twin = project({ ...archiveBacklog, projectName: 'Полевой архив' }, ['boris'], { repository: sensorRepo });
    const text = dailyReport(view('team', null, [first, twin]));
    expect(text.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(text).toContain('Проекты: Общественный сенсор, Полевой архив');
    expect(text).toContain('смержено PR 1');
    expect(text).toContain('коммитов 6');
    expect(text).not.toContain('смержено PR 2');
    expect(text).not.toContain('коммитов 12');
  });

  it('R-695 Закрытые issues в него не копируются', () => {
    const repo: ReportRepositoryFacts = {
      ...sensorRepo,
      closedIssueTitles: ['Telegram-интерфейс', 'Не для блока репозитория'],
    };
    const text = dailyReport(view('team', null, [project(sensorBacklog, ['ann'], { repository: repo })]));
    const github = text.split('\n\n').find((part) => part.startsWith('GitHub '));
    expect(github).toBe(sensorGithub);
    expect(github).not.toContain('#11');
    expect(github).not.toContain('Telegram-интерфейс');
    expect(github).not.toContain('Не для блока репозитория');
    expect(text).toContain('Закрыто: #11 Telegram-интерфейс');
  });

  it('INV-26 два проекта одного репозитория дают один блок GitHub, коммиты и PR не складываются', () => {
    const first = project(sensorBacklog, ['ann', 'boris'], { repository: sensorRepo });
    const twin = project({ ...archiveBacklog, projectName: 'Второй проект' }, ['boris'], { repository: sensorRepo });
    const team = dailyReport(view('team', null, [first, twin]));
    const dm = dailyReport(view('dm', 'ann', [first, twin]));
    expect(team.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(team).toContain('Проекты: Общественный сенсор, Второй проект');
    expect(team.match(/коммитов 6/g)).toHaveLength(1);
    expect(team.match(/смержено PR 1/g)).toHaveLength(1);
    expect(dm.match(/GitHub org\/sensor/g)).toHaveLength(1);
    expect(dm).toContain('Проекты: Общественный сенсор');
    expect(dm).not.toContain('Второй проект');
    expect(() =>
      dailyReport(view('team', null, [first, project(archiveBacklog, ['ann'], { repository: { ...sensorRepo, ci: 'failure' } })])),
    ).toThrow('коммиты и PR репозитория по проектам не складываются');
  });
});
