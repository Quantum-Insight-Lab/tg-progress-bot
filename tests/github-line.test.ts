import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CI_STATUS_CANCELLED,
  CI_STATUS_FAILURE,
  CI_STATUS_OTHER,
  CI_STATUS_SUCCESS,
} from '../src/domain/github/ci-status.ts';
import { githubCanvasLine, type GithubCanvasLine } from '../src/domain/github/canvas-line.ts';
import { calendarDaysBetween, projectCalendarDate } from '../src/domain/shared/project-time.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { loadGithubCanvasLine } from '../src/infrastructure/github-canvas.ts';
import {
  readCiMirrorMigration,
  readCommitsMigration,
  readEventsMigration,
  readMilestonesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import type { CanvasRichText } from '../src/projections/canvas-message.ts';
import { COMMITS_TAIL_DAYS } from '../src/config/constants.ts';
import { commitKeptInTail } from '../src/domain/github/commit.ts';
import { repositoryStallFacts } from '../src/domain/github/stall.ts';
import {
  GITHUB_LINE_DISCONNECTED,
  GITHUB_LINE_NO_DATA,
  githubLineParagraphs,
  githubLineText,
  githubSectionParagraphs,
} from '../src/projections/github-line.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const canvasDate = '2026-09-17';
const timezone = 'Europe/Moscow';
const projectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000011';
const bareProjectId = '00000000-0000-4000-8000-000000000012';
const repositoryId = '42';

const commits = [
  { createdAt: new Date('2026-09-16T17:00:00+03:00') },
  { createdAt: new Date('2026-09-17T01:00:00+03:00') },
  { createdAt: new Date('2026-09-17T12:00:00+03:00') },
  { createdAt: new Date('2026-09-17T22:00:00+03:00') },
  { createdAt: new Date('2026-09-18T10:00:00+03:00') },
];

const mirror = {
  owner: 'org',
  name: 'sensor',
  ci: CI_STATUS_SUCCESS,
  pullRequests: [{ state: 'open' }, { state: 'open' }, { state: 'closed' }, { state: 'merged' }],
  commits,
  milestones: [
    { milestoneNumber: 1, title: 'Архив', state: 'closed', dueOn: '2026-09-01' },
    { milestoneNumber: 4, title: 'Без срока', state: 'open', dueOn: null },
    { milestoneNumber: 3, title: 'Дальше', state: 'open', dueOn: '2026-11-01' },
    { milestoneNumber: 2, title: 'Pilot', state: 'open', dueOn: '2026-10-12' },
  ],
  canvasDate,
  timezone,
} as const;

const mockLine = githubCanvasLine(mirror);

const githubLine = 'GitHub org/sensor: CI зелёный · открытых PR 2 · коммитов за сутки 3 · milestone Pilot до 12.10';

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function painted(line: GithubCanvasLine | null): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate,
    sections: { github: githubSectionParagraphs(line) },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return prepared.message.blocks.map((block) => visible(block.text));
}

const lines = painted(mockLine);

describe('строка GitHub на канвасе', () => {
  it('R-085 он показывает, что происходит в репозитории', () => {
    expect(lines[1]).toBe(githubLine);
    expect(lines[1]).toContain('CI зелёный');
    expect(lines[1]).toContain('открытых PR 2');
    expect(lines[1]).toContain('коммитов за сутки 3');
    expect(lines[1]).toContain('milestone Pilot');
    expect(lines[1]).not.toContain('Архив');
    expect(lines[1]).not.toContain('Дальше');
    expect(lines[1]).not.toContain('Без срока');
  });

  it('R-134 «GitHub org/sensor»', () => {
    expect(lines[1]).toContain('GitHub org/sensor');
    expect(lines[1]?.startsWith('GitHub org/sensor:')).toBe(true);
  });

  it('R-135 «CI зелёный»', () => {
    expect(lines[1]).toContain('CI зелёный');
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_SUCCESS })).toContain('CI зелёный');
  });

  it('R-136 «открытых PR 2»', () => {
    expect(lines[1]).toContain('открытых PR 2');
    expect(mockLine.openPullRequests).toBe(2);
  });

  it('R-938 «коммитов за сутки 3»', () => {
    expect(lines[1]).toContain('коммитов за сутки 3');
    expect(mockLine.commitsOnDay).toBe(3);
    const tokyo = githubCanvasLine({ ...mirror, timezone: 'Asia/Tokyo' });
    expect(tokyo.commitsOnDay).toBe(2);
  });

  it('R-137 «milestone Pilot»', () => {
    expect(lines[1]).toContain('milestone Pilot');
    expect(mockLine.milestone).toEqual({ title: 'Pilot', dueOn: '2026-10-12' });
  });

  it('R-138 «до 12.10»', () => {
    expect(lines[1]).toContain('до 12.10');
    expect(lines[1]).not.toContain('2026');
  });

  it('R-357 на канвасе, если репозиторий подключён, — одна строка', () => {
    expect(githubLineParagraphs(mockLine)).toHaveLength(1);
    expect(lines).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09', githubLine]);
    expect(lines.filter((block) => block.startsWith('GitHub '))).toHaveLength(1);
  });

  it('R-363 нет даты — строка milestone не печатается', () => {
    const undated = githubCanvasLine({
      ...mirror,
      milestones: [
        { milestoneNumber: 4, title: 'Без срока', state: 'open', dueOn: null },
        { milestoneNumber: 1, title: 'Архив', state: 'closed', dueOn: null },
      ],
    });
    expect(undated.milestone).toBeNull();
    const text = githubLineText(undated);
    const shown = painted(undated);
    expect(text).not.toContain('milestone');
    expect(text).not.toContain('Без срока');
    expect(text).not.toContain('Архив');
    expect(shown).toEqual([
      'ПРОЕКТ: Общественный сенсор · 17.09',
      'GitHub org/sensor: CI зелёный · открытых PR 2 · коммитов за сутки 3',
    ]);
    expect(shown.join('\n')).not.toContain('до ');
  });

  it('R-364 CI неизвестен — на этой строке «Нет данных»', () => {
    const unknown = githubCanvasLine({ ...mirror, ci: null });
    expect(unknown.ci).toBeNull();
    const text = githubLineText(unknown);
    expect(text).toContain(GITHUB_LINE_NO_DATA);
    expect(text).toBe(
      `GitHub org/sensor: ${GITHUB_LINE_NO_DATA} · открытых PR 2 · коммитов за сутки 3 · milestone Pilot до 12.10`,
    );
    expect(text).not.toContain('CI зелёный');
    expect(text).not.toContain('CI красный');
    expect(painted(unknown)[1]).toBe(text);
  });

  it('INV-12 неизвестный CI — «Нет данных» на строке GitHub и не блокер: задачи строка не называет', () => {
    const unknown = githubCanvasLine({ ...mirror, ci: null });
    const text = githubLineText(unknown);
    expect(text).toContain(GITHUB_LINE_NO_DATA);
    expect(text).not.toContain('CI красный');
    const facts = repositoryStallFacts({
      now: new Date('2026-09-17T12:00:00+03:00'),
      repositories: [{ repositoryId, defaultBranchCi: null }],
      projects: [{ projectId, repositoryId, timezone }],
      members: [],
      pullRequests: [],
    });
    expect(facts.lines).toEqual([]);
    expect(facts.notices).toEqual([]);
    const packed = JSON.stringify({ line: unknown, facts });
    expect(packed).not.toContain('taskNumber');
    expect(packed).not.toContain('taskId');
    expect(packed).not.toContain('BLOCKED');
  });

  it('R-366 отдельного экрана GitHub нет', () => {
    expect(githubLineParagraphs(mockLine)).toHaveLength(1);
    expect(githubSectionParagraphs(null)).toHaveLength(1);
    const shown = painted(mockLine);
    expect(shown.filter((block) => block.includes('GitHub org/sensor'))).toEqual([githubLine]);
    expect(shown).toHaveLength(2);
    expect(githubLine).not.toContain('\n');
  });

  it('R-381 полный список PR в чат не вываливается', () => {
    const titles = ['Первый запрос', 'Второй запрос', 'Третий запрос'];
    const line = githubCanvasLine({
      ...mirror,
      pullRequests: titles.map(() => ({ state: 'open' })),
    });
    expect(line.openPullRequests).toBe(titles.length);
    const text = githubLineText(line);
    expect(text).toContain('открытых PR 3');
    expect(githubLineParagraphs(line)).toHaveLength(1);
    const shown = painted(line).join('\n');
    for (const title of titles) expect(shown).not.toContain(title);
    expect(shown).not.toContain('полный список');
  });

  it('R-182 строка GitHub показывает «репозиторий не подключён»', () => {
    expect(githubSectionParagraphs(null)).toEqual([
      { pieces: [{ kind: 'bold', text: GITHUB_LINE_DISCONNECTED }] },
    ]);
    expect(painted(null)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09', GITHUB_LINE_DISCONNECTED]);
    expect(painted(null).join('\n')).not.toContain('CI ');
    expect(painted(null).join('\n')).not.toContain('открытых PR');
  });

  it('R-340 git-ветки на канвас не выводятся', () => {
    const text = githubLineText(mockLine);
    expect(Object.keys(mockLine).sort()).toEqual([
      'ci',
      'commitsOnDay',
      'milestone',
      'name',
      'openPullRequests',
      'owner',
    ]);
    expect(text).not.toContain('feature/');
    expect(text).not.toContain('ветк');
    expect(painted(mockLine).join('\n')).not.toContain('main');
  });

  it('R-341 метки сами по себе на канвас не выводятся', () => {
    const text = githubLineText(mockLine);
    expect(text).not.toContain('bug');
    expect(text).not.toContain('метк');
    expect('labels' in mockLine).toBe(false);
    expect(painted(mockLine).join('\n')).not.toContain('label');
  });

  it('R-920 хвост коммитов кормит строку GitHub, журнал истории не печатается', () => {
    const outside = new Date('2026-09-09T12:00:00+03:00');
    const onDay = new Date('2026-09-17T15:00:00+03:00');
    const now = new Date('2026-09-17T23:00:00+03:00');
    expect(commitKeptInTail(outside.toISOString(), now)).toBe(false);
    expect(commitKeptInTail(onDay.toISOString(), now)).toBe(true);
    const aged = calendarDaysBetween(projectCalendarDate(outside, timezone), canvasDate);
    expect(aged).toBeGreaterThan(COMMITS_TAIL_DAYS);
    const line = githubCanvasLine({
      ...mirror,
      commits: [{ createdAt: outside }, { createdAt: onDay }, { createdAt: onDay }],
    });
    expect(line.commitsOnDay).toBe(2);
    const text = githubLineText(line);
    expect(text).toContain('коммитов за сутки 2');
    expect(text).not.toContain('sha');
    expect(text).not.toContain(outside.toISOString());
    expect(painted(line).join('\n')).not.toContain('журнал');
  });

  it('R-358 состояние CI основной git-ветки', () => {
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_SUCCESS })).toContain('CI зелёный');
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_FAILURE })).toContain('CI красный');
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_FAILURE })).not.toContain('CI зелёный');
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_CANCELLED })).toContain('CI отменён');
    expect(githubLineText({ ...mockLine, ci: CI_STATUS_OTHER })).toContain('CI иной');
    const redBranch = githubCanvasLine({ ...mirror, ci: CI_STATUS_FAILURE });
    expect(githubLineText(redBranch)).toContain('CI красный');
    expect(redBranch.ci).toBe(CI_STATUS_FAILURE);
  });

  it('R-360 ближайший открытый milestone', () => {
    expect(mockLine.milestone).toEqual({ title: 'Pilot', dueOn: '2026-10-12' });
    const sameDay = githubCanvasLine({
      ...mirror,
      milestones: [
        { milestoneNumber: 8, title: 'Позже номером', state: 'open', dueOn: '2026-10-12' },
        { milestoneNumber: 5, title: 'Раньше номером', state: 'open', dueOn: '2026-10-12' },
      ],
    });
    expect(sameDay.milestone).toEqual({ title: 'Раньше номером', dueOn: '2026-10-12' });
    const undated = githubCanvasLine({
      ...mirror,
      milestones: [{ milestoneNumber: 4, title: 'Без срока', state: 'open', dueOn: null }],
    });
    expect(undated.milestone).toBeNull();
    expect(githubLineText(undated)).not.toContain('milestone');
    expect(() =>
      githubCanvasLine({
        owner: ' ',
        name: 'sensor',
        ci: null,
        pullRequests: [],
        commits: [],
        milestones: [],
        canvasDate,
        timezone,
      }),
    ).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.REPOSITORY_OWNER_BLANK }));
  });
});

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

const opened: Handle[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.close()));
});

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(readCommitsMigration());
  await pglite.exec(readMilestonesMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

describe('строка GitHub читает зеркало репозитория', () => {
  it('R-357 R-358 подключённый репозиторий даёт одну строку из CI основной ветки', async () => {
    const handle = await openDb();
    opened.push(handle);
    await sql`
      INSERT INTO repositories (id, owner, name, default_branch_ci)
      VALUES (${repositoryId}, 'org', 'sensor', ${CI_STATUS_SUCCESS})
    `.execute(handle.db);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
      VALUES
        (${projectId}::uuid, 'Сенсор', '', ${timezone}, '2026-09-01T00:00:00Z', ${repositoryId}),
        (${otherProjectId}::uuid, 'Второй', '', ${timezone}, '2026-09-01T00:00:00Z', ${repositoryId}),
        (${bareProjectId}::uuid, 'Пустой', '', ${timezone}, '2026-09-01T00:00:00Z', NULL)
    `.execute(handle.db);
    await sql`
      INSERT INTO pull_requests (
        id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at
      )
      VALUES
        ('00000000-0000-4000-8000-0000000000a1'::uuid, ${repositoryId}, 1, 'полный список не печатается', 'ada', 'open', ${CI_STATUS_FAILURE}, '2026-09-17T10:00:00Z'),
        ('00000000-0000-4000-8000-0000000000a2'::uuid, ${repositoryId}, 2, 'второй открытый', 'ada', 'open', NULL, '2026-09-17T10:00:00Z'),
        ('00000000-0000-4000-8000-0000000000a3'::uuid, ${repositoryId}, 3, 'закрытый', 'ada', 'closed', NULL, '2026-09-17T10:00:00Z'),
        ('00000000-0000-4000-8000-0000000000a4'::uuid, ${repositoryId}, 4, 'смерженный', 'ada', 'merged', NULL, '2026-09-17T10:00:00Z')
    `.execute(handle.db);
    await sql`
      INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000b1'::uuid, ${repositoryId}, 'aaa', 'ветка feature/login', 'ada', '2026-09-16T17:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b2'::uuid, ${repositoryId}, 'bbb', 'утро', 'ada', '2026-09-17T01:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b3'::uuid, ${repositoryId}, 'ccc', 'метка bug', 'ada', '2026-09-17T12:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b4'::uuid, ${repositoryId}, 'ddd', 'вечер', 'ada', '2026-09-17T22:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b5'::uuid, ${repositoryId}, 'eee', 'завтра', 'ada', '2026-09-18T10:00:00+03:00')
    `.execute(handle.db);
    await sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state, due_on)
      VALUES
        ('00000000-0000-4000-8000-0000000000c1'::uuid, ${repositoryId}, 1, 'Архив', 'closed', '2026-09-01'),
        ('00000000-0000-4000-8000-0000000000c2'::uuid, ${repositoryId}, 2, 'Pilot', 'open', '2026-10-12'),
        ('00000000-0000-4000-8000-0000000000c3'::uuid, ${repositoryId}, 3, 'Дальше', 'open', '2026-11-01'),
        ('00000000-0000-4000-8000-0000000000c4'::uuid, ${repositoryId}, 4, 'Без срока', 'open', NULL)
    `.execute(handle.db);

    const loaded = await loadGithubCanvasLine(handle.db, projectId, canvasDate, timezone);
    if (loaded === null) throw new Error('репозиторий подключён');
    expect(githubLineText(loaded)).toBe(githubLine);
    const shown = painted(loaded);
    expect(shown).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09', githubLine]);
    expect(shown.join('\n')).not.toContain('полный список не печатается');
    expect(shown.join('\n')).not.toContain('утро');
    expect(shown.join('\n')).not.toContain('ветка feature/login');
    expect(shown.join('\n')).not.toContain('метка bug');
    expect(painted(null)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09', GITHUB_LINE_DISCONNECTED]);

    const shared = await loadGithubCanvasLine(handle.db, otherProjectId, canvasDate, timezone);
    if (shared === null) throw new Error('репозиторий подключён');
    expect(githubLineText(shared)).toBe(githubLine);

    expect(await loadGithubCanvasLine(handle.db, bareProjectId, canvasDate, timezone)).toBeNull();

    await sql`UPDATE repositories SET default_branch_ci = ${CI_STATUS_FAILURE} WHERE id = ${repositoryId}`.execute(handle.db);
    const red = await loadGithubCanvasLine(handle.db, projectId, canvasDate, timezone);
    if (red === null) throw new Error('репозиторий подключён');
    expect(githubLineText(red)).toContain('CI красный');
    expect(githubLineText(red)).not.toContain('CI зелёный');

    await sql`UPDATE repositories SET default_branch_ci = NULL WHERE id = ${repositoryId}`.execute(handle.db);
    const unknown = await loadGithubCanvasLine(handle.db, projectId, canvasDate, timezone);
    if (unknown === null) throw new Error('репозиторий подключён');
    expect(githubLineText(unknown)).toContain(GITHUB_LINE_NO_DATA);
    expect(githubLineText(unknown)).not.toContain('CI красный');
    const journal = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM events`.execute(handle.db);
    expect(Number(journal.rows[0]?.n ?? 0)).toBe(0);
  });
});
