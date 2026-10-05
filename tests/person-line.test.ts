import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PERSON_PLACE_ABSENT,
  PERSON_PLACE_SLICE,
  PERSON_PLACE_UNMATCHED,
  personBacklogPlace,
  type PersonBacklogIssue,
} from '../src/domain/progress/person-place.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readIssueMirrorMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { loadCanvasPerson } from '../src/infrastructure/person-canvas.ts';
import {
  PERSON_LINE_UNMATCHED,
  personLineFromPlace,
  personLineParagraphs,
} from '../src/projections/person-line.ts';
import { GITHUB_LINE_DISCONNECTED, githubSectionParagraphs } from '../src/projections/github-line.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';
import type { CanvasRichMessage, CanvasRichText } from '../src/projections/canvas-message.ts';

const repositoryId = '11';
const stranger = 'stranger';
const andreyId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000010';
const bareProjectId = '00000000-0000-4000-8000-000000000011';

const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  const handles = opened.splice(0);
  await Promise.all(handles.map((handle) => handle.close()));
});

function issue(
  issueNumber: number,
  state: 'open' | 'closed',
  stateReason: 'completed' | 'not_planned' | null,
  assignees: readonly string[],
): PersonBacklogIssue {
  return { repositoryId, issueNumber, state, stateReason, assignees };
}

const mockIssues: PersonBacklogIssue[] = [
  issue(1, 'closed', 'completed', ['Andrey']),
  issue(2, 'closed', 'completed', ['andrey']),
  issue(3, 'closed', 'completed', ['andrey', stranger]),
  issue(4, 'closed', 'completed', ['andrey']),
  issue(5, 'open', null, ['andrey', stranger]),
  issue(6, 'open', null, ['andrey']),
  ...Array.from({ length: 16 }, (_, index) =>
    issue(7 + index, 'open', null, index % 2 === 0 ? [stranger] : []),
  ),
  issue(100, 'closed', 'not_planned', ['andrey']),
  issue(101, 'closed', 'completed', [stranger]),
];

const andrey = {
  name: 'Андрей',
  place: personBacklogPlace('andrey', repositoryId, mockIssues),
};

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((block) => visible(block.text));
}

function painted(person: { name: string; place: ReturnType<typeof personBacklogPlace> }): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate: '2026-09-17',
    sections: { person: personLineParagraphs(personLineFromPlace(person)) },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return linesOf(prepared.message);
}

const personLine = 'Андрей по issues: сделал 4 · сейчас на нём 2 · дальше в репозитории 16';

describe('строка человека на канвасе', () => {
  it('R-111 «Андрей по issues»', () => {
    const lines = painted(andrey);
    expect(lines[1]).toBe(personLine);
    expect(lines[1]).toContain('Андрей по issues:');
    expect(personLineParagraphs(personLineFromPlace(andrey))).toHaveLength(1);
  });

  it('R-112 «сделал 4»', () => {
    expect(painted(andrey)[1]).toContain('сделал 4');
  });

  it('R-113 «сейчас на нём 2»', () => {
    expect(painted(andrey)[1]).toContain('сейчас на нём 2');
  });

  it('R-114 «дальше в репозитории 16»', () => {
    expect(painted(andrey)[1]).toContain('дальше в репозитории 16');
  });

  it('R-430 строка человека печатается как «нет сопоставления с GitHub»', () => {
    const lines = painted({ name: 'Андрей', place: personBacklogPlace(null, repositoryId, mockIssues) });
    expect(lines[1]).toBe(PERSON_LINE_UNMATCHED);
    expect(lines[1]).toBe('нет сопоставления с GitHub');
    expect(lines.join('\n')).not.toContain('Андрей');
    expect(lines.join('\n')).not.toContain('сделал');
  });

  it('R-434 чужой логин, не записанный ни на кого в боте, в строке человека не появляется', () => {
    expect(andrey.place.kind).toBe(PERSON_PLACE_SLICE);
    const lines = painted(andrey);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(stranger);
    expect(lines.join('\n')).not.toContain(`@${stranger}`);
    const onlyStranger = painted({
      name: 'Андрей',
      place: personBacklogPlace('andrey', repositoryId, [issue(4, 'open', null, [stranger])]),
    });
    expect(onlyStranger[1]).toBe('Андрей по issues: сделал 0 · сейчас на нём 0 · дальше в репозитории 1');
    expect(onlyStranger.join('\n')).not.toContain(stranger);
  });

  it('INV-14 пустой логин даёт «нет сопоставления с GitHub», место читается в момент показа', () => {
    expect(personBacklogPlace('   ', repositoryId, mockIssues).kind).toBe(PERSON_PLACE_UNMATCHED);
    expect(painted({ name: 'Андрей', place: personBacklogPlace('  ', repositoryId, mockIssues) })[1]).toBe(
      PERSON_LINE_UNMATCHED,
    );
    const empty = painted({
      name: 'Андрей',
      place: personBacklogPlace('andrey', repositoryId, []),
    });
    expect(empty[1]).toBe('Андрей по issues: сделал 0 · сейчас на нём 0 · дальше в репозитории 0');
    expect(empty[1]).not.toBe(PERSON_LINE_UNMATCHED);
  });

  it('R-979 без репозитория строка человека не печатается', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);

    const withLogin = await loadCanvasPerson(handle.db, bareProjectId, andreyId);
    expect(withLogin.place).toEqual({ kind: PERSON_PLACE_ABSENT });
    await sql`UPDATE users SET github_login = NULL WHERE id = ${andreyId}::uuid`.execute(handle.db);
    const withoutLogin = await loadCanvasPerson(handle.db, bareProjectId, andreyId);
    expect(withoutLogin.place).toEqual({ kind: PERSON_PLACE_ABSENT });

    for (const person of [withLogin, withoutLogin]) {
      const prepared = prepareCanvasMessage({
        projectName: 'Пустой',
        canvasDate: '2026-09-17',
        sections: {
          person: personLineParagraphs(personLineFromPlace(person)),
          github: githubSectionParagraphs(null),
        },
      });
      if (prepared.status !== 'ready') throw new Error('канвас не собрался');
      expect(prepared.message.blocks.some((block) => block.type === 'expandable_blockquote')).toBe(false);
      const text = linesOf(prepared.message).join('\n');
      expect(text).not.toContain('по issues');
      expect(text).not.toContain('сделал');
      expect(text).not.toContain(PERSON_LINE_UNMATCHED);
      expect(text).toContain(GITHUB_LINE_DISCONNECTED);
    }

    const connected = painted({ name: 'Андрей', place: personBacklogPlace('andrey', repositoryId, []) });
    expect(connected[1]).toBe('Андрей по issues: сделал 0 · сейчас на нём 0 · дальше в репозитории 0');
  });

  it('R-995 раскрывающийся блок без строки человека и без срезов не появляется', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Пустой',
      canvasDate: '2026-09-17',
      sections: {
        person: personLineParagraphs(personLineFromPlace({ name: 'Андрей', place: { kind: PERSON_PLACE_ABSENT } })),
        inProgress: [],
        next: [],
        done: [],
        github: githubSectionParagraphs(null),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    expect(prepared.message.blocks.some((block) => block.type === 'expandable_blockquote')).toBe(false);
  });

  it('R-996 у подключённого репозитория строка остаётся', () => {
    const lines = painted({ name: 'Андрей', place: personBacklogPlace('andrey', repositoryId, []) });
    expect(lines[1]).toBe('Андрей по issues: сделал 0 · сейчас на нём 0 · дальше в репозитории 0');
  });

  it('R-997 строка GitHub по-прежнему говорит «репозиторий не подключён»', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Пустой',
      canvasDate: '2026-09-17',
      sections: {
        person: personLineParagraphs(personLineFromPlace({ name: 'Андрей', place: { kind: PERSON_PLACE_ABSENT } })),
        github: githubSectionParagraphs(null),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    const github = prepared.message.blocks.find((block) => block.type === 'paragraph' && visible(block.text) === GITHUB_LINE_DISCONNECTED);
    expect(github).toBeDefined();
    expect(prepared.message.blocks.some((block) => block.type === 'expandable_blockquote')).toBe(false);
  });

  it('R-890 срез 3.4 строится по логинам issue_assignees', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);

    const first = await loadCanvasPerson(handle.db, projectId, andreyId);
    expect(first.name).toBe('Андрей');
    expect(first.place).toEqual({ kind: PERSON_PLACE_SLICE, done: [1], now: [3], next: [4, 5] });
    const paintedFirst = painted(first);
    expect(paintedFirst[1]).toBe('Андрей по issues: сделал 1 · сейчас на нём 1 · дальше в репозитории 2');
    expect(paintedFirst.join('\n')).not.toContain(stranger);

    await insertIssue(handle.db, '00000000-0000-4000-8000-0000000000f6', 6, 'open', null, null);
    await assign(handle.db, '00000000-0000-4000-8000-0000000000f6', 'Andrey');
    const again = await loadCanvasPerson(handle.db, projectId, andreyId);
    expect(again.place).toEqual({ kind: PERSON_PLACE_SLICE, done: [1], now: [3, 6], next: [4, 5] });
    expect(painted(again)[1]).toContain('сейчас на нём 2');

    await sql`UPDATE users SET github_login = NULL WHERE id = ${andreyId}::uuid`.execute(handle.db);
    const unmatched = await loadCanvasPerson(handle.db, projectId, andreyId);
    expect(unmatched.place).toEqual({ kind: PERSON_PLACE_UNMATCHED });
    expect(painted(unmatched)[1]).toBe(PERSON_LINE_UNMATCHED);

    await sql`UPDATE users SET github_login = 'andrey' WHERE id = ${andreyId}::uuid`.execute(handle.db);
    const bare = await loadCanvasPerson(handle.db, bareProjectId, andreyId);
    expect(bare.place).toEqual({ kind: PERSON_PLACE_ABSENT });
    expect(painted(bare)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
  });
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
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f1', 1, 'closed', 'completed', 'someone');
  await assign(db, '00000000-0000-4000-8000-0000000000f1', 'andrey');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f2', 2, 'closed', 'completed', 'andrey');
  await assign(db, '00000000-0000-4000-8000-0000000000f2', stranger);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f3', 3, 'open', null, null);
  await assign(db, '00000000-0000-4000-8000-0000000000f3', 'andrey');
  await assign(db, '00000000-0000-4000-8000-0000000000f3', stranger);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f4', 4, 'open', null, null);
  await assign(db, '00000000-0000-4000-8000-0000000000f4', stranger);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f5', 5, 'open', null, null);
}

async function insertIssue(
  db: Kysely<Database>,
  id: string,
  issueNumber: number,
  state: 'open' | 'closed',
  stateReason: 'completed' | 'not_planned' | null,
  closedByLogin: string | null,
): Promise<void> {
  await sql`
    INSERT INTO issues (
      id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
    )
    VALUES (
      ${id}::uuid,
      ${repositoryId},
      ${issueNumber},
      ${`issue ${String(issueNumber)}`},
      ${state},
      ${stateReason},
      ${closedByLogin},
      '2026-09-17T08:00:00.000Z'::timestamptz,
      ${state === 'closed' ? '2026-09-17T09:00:00.000Z' : null}::timestamptz
    )
  `.execute(db);
}

async function assign(db: Kysely<Database>, issueId: string, login: string): Promise<void> {
  await sql`
    INSERT INTO issue_assignees (issue_id, login) VALUES (${issueId}::uuid, ${login})
  `.execute(db);
}
