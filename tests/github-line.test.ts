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
import { githubLineParagraphs, githubLineText } from '../src/projections/github-line.ts';
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
  return text.button.text;
}

function painted(line: GithubCanvasLine | null): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate,
    sections: { github: line === null ? [] : githubLineParagraphs(line) },
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
    expect(painted(null)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
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
        ('00000000-0000-4000-8000-0000000000b1'::uuid, ${repositoryId}, 'aaa', 'вчера', 'ada', '2026-09-16T17:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b2'::uuid, ${repositoryId}, 'bbb', 'утро', 'ada', '2026-09-17T01:00:00+03:00'),
        ('00000000-0000-4000-8000-0000000000b3'::uuid, ${repositoryId}, 'ccc', 'день', 'ada', '2026-09-17T12:00:00+03:00'),
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

    const shared = await loadGithubCanvasLine(handle.db, otherProjectId, canvasDate, timezone);
    if (shared === null) throw new Error('репозиторий подключён');
    expect(githubLineText(shared)).toBe(githubLine);

    expect(await loadGithubCanvasLine(handle.db, bareProjectId, canvasDate, timezone)).toBeNull();

    await sql`UPDATE repositories SET default_branch_ci = ${CI_STATUS_FAILURE} WHERE id = ${repositoryId}`.execute(handle.db);
    const red = await loadGithubCanvasLine(handle.db, projectId, canvasDate, timezone);
    if (red === null) throw new Error('репозиторий подключён');
    expect(githubLineText(red)).toContain('CI красный');
    expect(githubLineText(red)).not.toContain('CI зелёный');
  });
});
