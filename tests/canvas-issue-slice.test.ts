import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_SLICE_SIZE } from '../src/config/constants.ts';
import {
  canvasIssueSlice,
  type CanvasMirrorIssue,
  type CanvasSliceUser,
} from '../src/domain/progress/canvas-issue-slice.ts';
import { loadCanvasIssueSlice } from '../src/infrastructure/canvas-issue-slice.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readIssueDependenciesMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import type { CanvasRichMessage, CanvasRichText } from '../src/projections/canvas-message.ts';
import {
  doneSliceParagraphs,
  inProgressSliceParagraphs,
  nextSliceParagraphs,
} from '../src/projections/issue-slice.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const repositoryId = '11';
const users: CanvasSliceUser[] = [
  { githubLogin: 'andrey', name: 'Андрей' },
  { githubLogin: 'maria', name: 'Мария' },
];

function mirror(input: {
  issueNumber: number;
  title: string;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | null;
  closedAt?: string | null;
  assignees?: readonly string[];
  links?: CanvasMirrorIssue['links'];
}): CanvasMirrorIssue {
  return {
    repositoryId,
    issueNumber: input.issueNumber,
    title: input.title,
    state: input.state,
    stateReason: input.stateReason ?? null,
    closedAt: input.closedAt ?? null,
    assignees: input.assignees ?? [],
    links: input.links ?? [],
  };
}

function closed(issueNumber: number): CanvasMirrorIssue {
  const day = String(issueNumber).padStart(2, '0');
  return mirror({
    issueNumber,
    title: `done ${String(issueNumber)}`,
    state: 'closed',
    stateReason: 'completed',
    closedAt: `2026-09-${day}T00:00:00.000Z`,
    assignees: ['andrey'],
  });
}

const backlog: CanvasMirrorIssue[] = [
  closed(1),
  closed(2),
  closed(3),
  closed(4),
  closed(5),
  closed(6),
  mirror({
    issueNumber: 10,
    title: 'классификация сигналов',
    state: 'open',
    assignees: ['Andrey'],
    links: [
      { dependsOnIssueNumber: 30, linkType: 'blocked_by' },
      { dependsOnIssueNumber: 31, linkType: 'sub_issue' },
    ],
  }),
  mirror({ issueNumber: 11, title: 'неизвестный логин', state: 'open', assignees: ['octocat'] }),
  mirror({ issueNumber: 12, title: 'два человека', state: 'open', assignees: ['maria', 'andrey'] }),
  mirror({ issueNumber: 13, title: 'ещё работа', state: 'open', assignees: ['andrey'] }),
  mirror({ issueNumber: 14, title: 'пятая работа', state: 'open', assignees: ['andrey'] }),
  mirror({
    issueNumber: 15,
    title: 'лишняя работа',
    state: 'open',
    assignees: ['andrey'],
    links: [{ dependsOnIssueNumber: 77, linkType: 'blocked_by' }],
  }),
  mirror({ issueNumber: 20, title: 'next 20', state: 'open' }),
  mirror({ issueNumber: 21, title: 'next 21', state: 'open' }),
  mirror({ issueNumber: 22, title: 'next 22', state: 'open' }),
  mirror({ issueNumber: 23, title: 'next 23', state: 'open' }),
  mirror({ issueNumber: 24, title: 'next 24', state: 'open' }),
  mirror({
    issueNumber: 25,
    title: 'лишнее далее',
    state: 'open',
    links: [{ dependsOnIssueNumber: 88, linkType: 'sub_issue' }],
  }),
  mirror({
    issueNumber: 30,
    title: 'не в плане',
    state: 'closed',
    stateReason: 'not_planned',
    closedAt: '2026-09-28T00:00:00.000Z',
  }),
  mirror({
    issueNumber: 31,
    title: 'подзадача вне среза',
    state: 'closed',
    stateReason: 'not_planned',
    closedAt: '2026-09-28T00:00:00.000Z',
  }),
];

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((block) => visible(block.text));
}

function painted(issues: readonly CanvasMirrorIssue[] = backlog): string[] {
  const slice = canvasIssueSlice(repositoryId, issues, users);
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate: '2026-09-17',
    sections: {
      done: doneSliceParagraphs(slice.done),
      inProgress: inProgressSliceParagraphs(slice.inProgress),
      next: nextSliceParagraphs(slice.next),
    },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return linesOf(prepared.message);
}

function between(lines: readonly string[], heading: string, nextHeading: string | null): string[] {
  const start = lines.indexOf(heading);
  const end = nextHeading === null ? lines.length : lines.indexOf(nextHeading);
  return lines.slice(start + 1, end);
}

const lines = painted();
const done = between(lines, 'Сделано', 'В работе');
const working = between(lines, 'В работе', 'Далее');
const next = between(lines, 'Далее', null);

describe('срез issues: assignees, связи, лимит', () => {
  it('R-151 У issue в «В работе» стоит имя assignee — пользователь бота по github_login', () => {
    expect(working[0]).toBe('#10 классификация сигналов — Андрей · blocked by #30 · sub-issue #31;');
    expect(working[0]).toContain('— Андрей');
    expect(done.join('\n')).not.toContain('— Андрей');
  });

  it('R-152 незаписанный логин печатается как @login', () => {
    expect(working[1]).toBe('#11 неизвестный логин — @octocat;');
  });

  it('R-153 несколько assignees — через запятую', () => {
    expect(working[2]).toBe('#12 два человека — Андрей, Мария;');
    expect(working[2]).toContain('Андрей, Мария');
  });

  it('R-383 issues не вываливаются полным списком', () => {
    const body = lines.join('\n');
    expect(lines.filter((line) => line.startsWith('#')).length).toBe(CANVAS_SLICE_SIZE * 3);
    expect(body).not.toContain('done 1');
    expect(body).not.toContain('лишняя работа');
    expect(body).not.toContain('лишнее далее');
    expect(body).not.toContain('не в плане');
    expect(body).not.toContain('подзадача вне среза');
    expect(body).not.toContain('blocked by #77');
    expect(body).not.toContain('#88');
  });

  it('R-386 связи дописываются к issue, который и так попал в срез', () => {
    expect(working[0]).toContain('· blocked by #30 · sub-issue #31;');
    expect(lines.join('\n')).not.toContain('подзадача вне среза');
    expect(lines.join('\n')).not.toContain('не в плане');
    expect(lines.join('\n')).not.toContain('лишняя работа');
    expect(lines.join('\n')).not.toContain('#77');
  });

  it('R-482 до пяти последних issues completed', () => {
    expect(done).toEqual(['#6 done 6;', '#5 done 5;', '#4 done 4;', '#3 done 3;', '#2 done 2.']);
    expect(done).toHaveLength(CANVAS_SLICE_SIZE);
    expect(lines.join('\n')).not.toContain('done 1');
  });

  it('R-484 до пяти открытых issues, у которых есть assignee', () => {
    expect(working).toEqual([
      '#10 классификация сигналов — Андрей · blocked by #30 · sub-issue #31;',
      '#11 неизвестный логин — @octocat;',
      '#12 два человека — Андрей, Мария;',
      '#13 ещё работа — Андрей;',
      '#14 пятая работа — Андрей.',
    ]);
    expect(lines.join('\n')).not.toContain('лишняя работа');
    expect(next.join('\n')).not.toContain('классификация сигналов');
  });

  it('R-486 до пяти открытых issues без assignee', () => {
    expect(next).toEqual(['#20 next 20;', '#21 next 21;', '#22 next 22;', '#23 next 23;', '#24 next 24.']);
    expect(next).toHaveLength(CANVAS_SLICE_SIZE);
    expect(lines.join('\n')).not.toContain('лишнее далее');
    expect(next.join('\n')).not.toContain('—');
  });

  it('R-151 имя assignee читается из users по github_login', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const slice = await loadCanvasIssueSlice(handle.db, projectId);
    const prepared = prepareCanvasMessage({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        done: doneSliceParagraphs(slice.done),
        inProgress: inProgressSliceParagraphs(slice.inProgress),
        next: nextSliceParagraphs(slice.next),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    const shown = linesOf(prepared.message);
    expect(shown).toContain('#10 классификация сигналов — Андрей · blocked by #30 · sub-issue #31.');
    expect(shown).toContain('#4 архитектура проекта.');
    expect(shown.join('\n')).not.toContain('не в плане');
    const bare = await loadCanvasIssueSlice(handle.db, bareProjectId);
    expect(bare).toEqual({ done: [], inProgress: [], next: [] });
  });
});

const opened: { close: () => Promise<void> }[] = [];
const projectId = '00000000-0000-4000-8000-000000000010';
const bareProjectId = '00000000-0000-4000-8000-000000000011';
const andreyId = '00000000-0000-4000-8000-000000000001';

afterEach(async () => {
  const handles = opened.splice(0);
  await Promise.all(handles.map((handle) => handle.close()));
});

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readIssueMirrorMigration());
  await pglite.exec(readIssueDependenciesMigration());
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

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root, github_login)
    VALUES (${andreyId}::uuid, 1001, 'Андрей', true, 'andrey')
  `.execute(db);
  await sql`
    INSERT INTO repositories (id, owner, name) VALUES (${repositoryId}, 'lab', 'bot')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
    VALUES
      (${projectId}::uuid, 'Сенсор', '', 'Europe/Moscow', '2026-09-17T08:00:00.000Z'::timestamptz, ${repositoryId}),
      (${bareProjectId}::uuid, 'Пустой', '', 'Europe/Moscow', '2026-09-17T08:00:00.000Z'::timestamptz, NULL)
  `.execute(db);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000a4', 4, 'архитектура проекта', 'closed', 'completed', '2026-09-01T00:00:00.000Z');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000b0', 10, 'классификация сигналов', 'open', null, null);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000c0', 30, 'не в плане', 'closed', 'not_planned', '2026-09-02T00:00:00.000Z');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000c1', 31, 'подзадача вне среза', 'closed', 'not_planned', '2026-09-02T00:00:00.000Z');
  await sql`
    INSERT INTO issue_assignees (issue_id, login) VALUES (${'00000000-0000-4000-8000-0000000000b0'}::uuid, 'Andrey')
  `.execute(db);
  await sql`
    INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, link_type)
    VALUES
      (${'00000000-0000-4000-8000-0000000000b0'}::uuid, ${'00000000-0000-4000-8000-0000000000c0'}::uuid, 'blocked_by'),
      (${'00000000-0000-4000-8000-0000000000b0'}::uuid, ${'00000000-0000-4000-8000-0000000000c1'}::uuid, 'sub_issue')
  `.execute(db);
}

async function insertIssue(
  db: Kysely<Database>,
  id: string,
  issueNumber: number,
  title: string,
  state: 'open' | 'closed',
  stateReason: 'completed' | 'not_planned' | null,
  closedAt: string | null,
): Promise<void> {
  await sql`
    INSERT INTO issues (
      id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
    )
    VALUES (
      ${id}::uuid,
      ${repositoryId},
      ${issueNumber},
      ${title},
      ${state},
      ${stateReason},
      NULL,
      '2026-09-17T08:00:00.000Z'::timestamptz,
      ${closedAt}::timestamptz
    )
  `.execute(db);
}
