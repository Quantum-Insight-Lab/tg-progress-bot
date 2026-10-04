import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { CI_STATUS_FAILURE, CI_STATUS_SUCCESS, type CiStatus } from '../src/domain/github/ci-status.ts';
import { githubCanvasLine } from '../src/domain/github/canvas-line.ts';
import { PULL_REQUEST_STATE_OPEN } from '../src/domain/github/pull-request.ts';
import { repositoryStallFacts, type StallPullRequest } from '../src/domain/github/stall.ts';
import { loadCanvasBlockers, selectCanvasBlockers } from '../src/infrastructure/canvas-blockers.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readCiMirrorMigration,
  readEventsMigration,
  readIssuesMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { type CanvasRichMessage, type CanvasRichText, renderCanvas } from '../src/projections/canvas-message.ts';
import { blockersBlockParagraphs, type BlockersBlock } from '../src/projections/blockers-block.ts';
import { githubSectionParagraphs } from '../src/projections/github-line.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const borisId = '00000000-0000-4000-8000-000000000001';
const repositoryId = '42';
const timezone = 'Europe/Moscow';
const canvasDate = '2026-09-17';
const now = new Date('2026-09-17T09:00:00.000Z');
const stalledAt = new Date('2026-09-14T09:00:00.000Z');

const quietIssues = [
  { id: '00000000-0000-4000-8000-0000000000f1', issueNumber: 15, title: 'Тихий сигнал' },
  { id: '00000000-0000-4000-8000-0000000000f2', issueNumber: 16, title: 'Без комментария' },
  { id: '00000000-0000-4000-8000-0000000000f3', issueNumber: 21, title: 'Без коммита' },
  { id: '00000000-0000-4000-8000-0000000000f4', issueNumber: 22, title: 'Без запроса' },
] as const;

const borisRed: StallPullRequest = {
  id: '00000000-0000-4000-8000-0000000000d1',
  repositoryId,
  pullRequestNumber: 138,
  authorLogin: 'boris',
  state: PULL_REQUEST_STATE_OPEN,
  ciStatus: CI_STATUS_FAILURE,
  updatedAt: stalledAt,
};

const borisGreen: StallPullRequest = {
  id: '00000000-0000-4000-8000-0000000000d2',
  repositoryId,
  pullRequestNumber: 140,
  authorLogin: 'boris',
  state: PULL_REQUEST_STATE_OPEN,
  ciStatus: CI_STATUS_SUCCESS,
  updatedAt: stalledAt,
};

const veraRed: StallPullRequest = {
  id: '00000000-0000-4000-8000-0000000000d3',
  repositoryId,
  pullRequestNumber: 202,
  authorLogin: 'vera',
  state: PULL_REQUEST_STATE_OPEN,
  ciStatus: CI_STATUS_FAILURE,
  updatedAt: stalledAt,
};

const stranger: StallPullRequest = {
  id: '00000000-0000-4000-8000-0000000000d4',
  repositoryId,
  pullRequestNumber: 201,
  authorLogin: 'stranger',
  state: PULL_REQUEST_STATE_OPEN,
  ciStatus: CI_STATUS_FAILURE,
  updatedAt: stalledAt,
};

const mirrorPullRequests = [borisRed, borisGreen, veraRed, stranger];

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((item) => visible(item.text));
}

function isolated(text: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${String(value)}(?:\\D|$)`).test(text);
}

function blockFor(login: string, ci: CiStatus): BlockersBlock {
  const facts = repositoryStallFacts({
    now,
    repositories: [{ repositoryId, defaultBranchCi: ci }],
    projects: [{ projectId, repositoryId, timezone }],
    members: [
      { projectId, githubLogin: 'boris' },
      { projectId, githubLogin: 'vera' },
    ],
    pullRequests: mirrorPullRequests,
  });
  return selectCanvasBlockers({ projectId, githubLogin: login, reasons: [], lines: facts.lines });
}

function paint(block: BlockersBlock, ci: CiStatus): string[] {
  const github = githubCanvasLine({
    owner: 'org',
    name: 'sensor',
    ci,
    pullRequests: mirrorPullRequests.map((item) => ({ state: item.state })),
    commits: [],
    milestones: [],
    canvasDate,
    timezone,
  });
  return linesOf(
    renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate,
      sections: {
        blockers: blockersBlockParagraphs(block),
        github: githubSectionParagraphs(github),
      },
    }),
  );
}

function blockerBody(lines: readonly string[]): string[] {
  const start = lines.indexOf('Блокеры');
  const githubAt = lines.findIndex((line) => line.startsWith('GitHub '));
  return lines.slice(start, githubAt);
}

const borisRedCanvas = paint(blockFor('boris', CI_STATUS_FAILURE), CI_STATUS_FAILURE);
const borisGreenCanvas = paint(blockFor('boris', CI_STATUS_SUCCESS), CI_STATUS_SUCCESS);
const veraCanvas = paint(blockFor('vera', CI_STATUS_FAILURE), CI_STATUS_FAILURE);

describe('блок «Блокеры»: строки CI и PR', () => {
  it('R-276 с пометкой про CI', () => {
    const marked = borisRedCanvas.filter((line) => line.startsWith('PR #138'));
    expect(marked).toEqual(['PR #138 без движения, CI красный']);
    expect(marked[0]).not.toContain('\n');
    const note = borisRedCanvas.indexOf('PR #138 без движения, CI красный');
    expect(borisRedCanvas[note + 1]).not.toContain('CI красный');
    const plain = borisRedCanvas.filter((line) => line.startsWith('PR #140'));
    expect(plain).toEqual(['PR #140 без движения']);
    expect(plain[0]).not.toContain('CI');
  });

  it('R-375 в блокеры — красный CI', () => {
    const body = blockerBody(borisRedCanvas);
    expect(body[0]).toBe('Блокеры');
    expect(body).toContain('CI основной ветки красный');
    expect(body.filter((line) => line === 'CI основной ветки красный')).toHaveLength(1);
    const github = borisRedCanvas.find((line) => line.startsWith('GitHub '));
    expect(github).toContain('CI красный');
    expect(github).not.toContain('CI основной ветки красный');
  });

  it('R-376 и застоявшиеся PR участников', () => {
    expect(blockerBody(borisRedCanvas)).toContain('PR #138 без движения, CI красный');
    expect(blockerBody(borisRedCanvas)).toContain('PR #140 без движения');
    expect(blockerBody(veraCanvas)).toContain('PR #202 без движения, CI красный');
    expect(blockerBody(borisRedCanvas).join('\n')).not.toContain('PR #202');
    expect(blockerBody(veraCanvas).join('\n')).not.toContain('PR #138');
  });

  it('R-390 зелёный CI отдельной строкой в блокеры не пишется', () => {
    const body = blockerBody(borisGreenCanvas);
    expect(body.join('\n')).not.toContain('зелён');
    expect(body).not.toContain('CI основной ветки красный');
    expect(body).not.toContain('CI зелёный');
    const github = borisGreenCanvas.find((line) => line.startsWith('GitHub '));
    expect(github).toContain('CI зелёный');
    expect(github?.startsWith('GitHub ')).toBe(true);
    expect(body.filter((line) => line.startsWith('PR #140'))).toEqual(['PR #140 без движения']);
  });

  it('R-399 отдельной строкой на канвасе его нет', () => {
    expect(stranger.authorLogin).toBe('stranger');
    const shown = borisRedCanvas.join('\n');
    expect(shown).not.toContain('stranger');
    expect(shown).not.toContain('PR #201');
    for (const line of borisRedCanvas) expect(line).not.toBe('stranger');
    expect(veraCanvas.join('\n')).not.toContain('stranger');
    expect(veraCanvas.join('\n')).not.toContain('PR #201');
    const github = borisRedCanvas.find((line) => line.startsWith('GitHub '));
    expect(github).toContain('открытых PR 4');
    expect(github).not.toContain('stranger');
  });
});

describe('число тихих issues на канвас не печатается', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    const fixture = opened.pop();
    if (fixture !== undefined) await fixture.close();
  });

  it('R-278 число таких issues на канвас', async () => {
    const pglite = new PGlite();
    await pglite.exec(readEventsMigration());
    await pglite.exec(readUsersMigration());
    await pglite.exec(readProjectsMigration());
    await pglite.exec(readProjectMembersMigration());
    await pglite.exec(readRepositoriesMigration());
    await pglite.exec(readProjectRepositoryMigration());
    await pglite.exec(readIssuesMigration());
    await pglite.exec(readPullRequestsMigration());
    await pglite.exec(readCiMirrorMigration());
    const db = new Kysely<Database>({
      dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
    });
    opened.push({
      async close() {
        await db.destroy();
      },
    });

    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root, github_login)
      VALUES (${borisId}::uuid, 1002, 'Борис', true, 'boris')
    `.execute(db);
    await sql`
      INSERT INTO repositories (id, owner, name, default_branch_ci)
      VALUES (${repositoryId}, 'org', 'sensor', ${CI_STATUS_FAILURE})
    `.execute(db);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
      VALUES (${projectId}::uuid, 'Сенсор', '', ${timezone}, ${now.toISOString()}::timestamptz, ${repositoryId})
    `.execute(db);
    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES ('00000000-0000-4000-8000-0000000000c1'::uuid, ${projectId}::uuid, ${borisId}::uuid, 'member')
    `.execute(db);
    for (const issue of quietIssues) {
      await sql`
        INSERT INTO issues (
          id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
        )
        VALUES (
          ${issue.id}::uuid, ${repositoryId}, ${issue.issueNumber}, ${issue.title}, 'open', null, null,
          ${stalledAt.toISOString()}::timestamptz, null
        )
      `.execute(db);
    }
    await sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at)
      VALUES (
        ${borisRed.id}::uuid, ${repositoryId}, 138, 'долгий', 'boris', 'open', ${CI_STATUS_FAILURE},
        ${stalledAt.toISOString()}::timestamptz
      )
    `.execute(db);

    const loaded = await loadCanvasBlockers(db, projectId, borisId, now);
    expect(Object.keys(loaded).sort()).toEqual(['defaultBranchCiRed', 'pullRequests', 'reasons']);
    const stored = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(db);
    expect(Number(stored.rows[0]?.n)).toBe(quietIssues.length);

    const shown = linesOf(
      renderCanvas({
        projectName: 'Общественный сенсор',
        canvasDate,
        sections: {
          blockers: blockersBlockParagraphs(loaded),
          github: githubSectionParagraphs(
            githubCanvasLine({
              owner: 'org',
              name: 'sensor',
              ci: CI_STATUS_FAILURE,
              pullRequests: [{ state: PULL_REQUEST_STATE_OPEN }],
              commits: [],
              milestones: [],
              canvasDate,
              timezone,
            }),
          ),
        },
      }),
    ).join('\n');
    expect(isolated(shown, quietIssues.length)).toBe(false);
    expect(shown).not.toMatch(/issue/i);
    expect(shown).not.toContain('тихих');
    for (const issue of quietIssues) {
      expect(shown).not.toContain(issue.title);
      expect(shown).not.toContain(`#${String(issue.issueNumber)}`);
      expect(isolated(shown, issue.issueNumber)).toBe(false);
    }
  });
});
