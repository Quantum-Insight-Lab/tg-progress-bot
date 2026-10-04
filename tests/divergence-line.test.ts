import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasDivergenceDate } from '../src/domain/progress/divergence.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { loadCanvasDivergence } from '../src/infrastructure/canvas-divergence.ts';
import {
  readBlockersMigration,
  readCiMirrorMigration,
  readCommitsMigration,
  readEventsMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import type { CanvasRichText } from '../src/projections/canvas-message.ts';
import { DIVERGENCE_LINE, divergenceLineParagraphs } from '../src/projections/divergence-line.ts';
import { githubSectionParagraphs } from '../src/projections/github-line.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const repo = '42';
const alphaId = '00000000-0000-4000-8000-0000000000a1';
const adaId = '00000000-0000-4000-8000-0000000000b1';
const graceId = '00000000-0000-4000-8000-0000000000b2';
const taskId = '00000000-0000-4000-8000-0000000000c1';
const blockerId = '00000000-0000-4000-8000-0000000000d1';
const memberAda = '00000000-0000-4000-8000-0000000000e1';
const canvasDate = '2026-09-29';
const timezone = 'Europe/Moscow';
const closedDay = '2026-09-28T12:00:00.000Z';
const openDay = '2026-09-29T10:00:00.000Z';
const weekBefore = '2026-09-20T12:00:00.000Z';

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

interface StoredTask {
  status: string;
}

interface StoredBlocker {
  id: string;
  reason: string | null;
  resolved_at: Date | string | null;
}

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readPullRequestsMigration());
  await pglite.exec(readCiMirrorMigration());
  await pglite.exec(readCommitsMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
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
    VALUES
      (${adaId}::uuid, 1, 'Ада', true, 'ada'),
      (${graceId}::uuid, 2, 'Грейс', false, 'grace')
  `.execute(db);
  await sql`
    INSERT INTO repositories (id, owner, name, default_branch_ci)
    VALUES (${repo}, 'lab', 'bot', 'failure')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
    VALUES (${alphaId}::uuid, 'Альфа', '', ${timezone}, ${weekBefore}::timestamptz, ${repo})
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (${memberAda}::uuid, ${alphaId}::uuid, ${adaId}::uuid, 'member')
  `.execute(db);
  await sql`
    INSERT INTO tasks (
      id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at
    )
    VALUES (
      ${taskId}::uuid, ${alphaId}::uuid, 1, 'идёт', 'IN_PROGRESS', 'normal', ${adaId}::uuid,
      ${weekBefore}::timestamptz, ${weekBefore}::timestamptz, NULL
    )
  `.execute(db);
  await sql`
    INSERT INTO blockers (id, task_id, reason, asked_at, resolved_at)
    VALUES (${blockerId}::uuid, ${taskId}::uuid, 'жду', ${weekBefore}::timestamptz, NULL)
  `.execute(db);
}

async function insertCommit(db: Kysely<Database>, id: string, sha: string, author: string, at: string): Promise<void> {
  await sql`
    INSERT INTO commits (id, repository_id, sha, message, author_login, created_at)
    VALUES (${id}::uuid, ${repo}, ${sha}, 'правка', ${author}, ${at}::timestamptz)
  `.execute(db);
}

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const found = await sql<StoredTask>`SELECT status FROM tasks ORDER BY id`.execute(db);
  return found.rows;
}

async function blockersOf(db: Kysely<Database>): Promise<StoredBlocker[]> {
  const found = await sql<StoredBlocker>`
    SELECT id::text AS id, reason, resolved_at FROM blockers ORDER BY id
  `.execute(db);
  return found.rows;
}

async function eventCount(db: Kysely<Database>): Promise<number> {
  const found = await sql<{ count: string }>`SELECT count(*)::text AS count FROM events`.execute(db);
  return Number(found.rows[0]?.count ?? '0');
}

describe('строка расхождения на канвасе', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-15 строка смотрит на закрытые сутки перед датой канваса', () => {
    expect(canvasDivergenceDate(canvasDate)).toBe('2026-09-28');
    expect(divergenceLineParagraphs(false)).toEqual([]);
  });

  it('R-414 Текст: «В репозитории есть движение, в задачах за сутки тишина»', () => {
    expect(DIVERGENCE_LINE).toBe('В репозитории есть движение, в задачах за сутки тишина');
    expect(divergenceLineParagraphs(true)).toEqual([{ pieces: [{ kind: 'text', text: DIVERGENCE_LINE }] }]);
  });

  it('R-508 строка расхождения стоит под GitHub', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Общественный сенсор',
      canvasDate,
      sections: {
        dynamics: [{ pieces: [{ kind: 'text', text: 'динамика' }] }],
        divergence: divergenceLineParagraphs(true),
        github: githubSectionParagraphs(null),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    const lines = prepared.message.blocks.map((block) => visible(block.text));
    const github = lines.indexOf('репозиторий не подключён');
    expect(lines[github + 1]).toBe(DIVERGENCE_LINE);
    expect(lines[github + 2]).toBe('динамика');
    const quiet = prepareCanvasMessage({
      projectName: 'Общественный сенсор',
      canvasDate,
      sections: {
        github: githubSectionParagraphs(null),
        divergence: divergenceLineParagraphs(false),
      },
    });
    if (quiet.status !== 'ready') throw new Error('канвас не собрался');
    expect(quiet.message.blocks.map((block) => visible(block.text))).not.toContain(DIVERGENCE_LINE);
  });

  it('INV-15 красный CI, чужой логин и ещё открытый день строку не зажигают; сигнал не меняет статусы и не создаёт блокер', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const tasks = await tasksOf(handle.db);
    const blockers = await blockersOf(handle.db);
    expect(await eventCount(handle.db)).toBe(0);
    expect(await loadCanvasDivergence(handle.db, alphaId, canvasDate, timezone)).toBe(false);

    await insertCommit(handle.db, '00000000-0000-4000-8000-0000000000f1', 'aaa1111', 'grace', closedDay);
    expect(await loadCanvasDivergence(handle.db, alphaId, canvasDate, timezone)).toBe(false);

    await insertCommit(handle.db, '00000000-0000-4000-8000-0000000000f2', 'bbb2222', 'ada', openDay);
    expect(await loadCanvasDivergence(handle.db, alphaId, canvasDate, timezone)).toBe(false);

    await insertCommit(handle.db, '00000000-0000-4000-8000-0000000000f3', 'ccc3333', 'ada', closedDay);
    expect(await loadCanvasDivergence(handle.db, alphaId, canvasDate, timezone)).toBe(true);
    expect(await tasksOf(handle.db)).toEqual(tasks);
    expect(tasks[0]?.status).toBe('IN_PROGRESS');
    expect(await blockersOf(handle.db)).toEqual(blockers);
    expect(blockers).toHaveLength(1);
    expect(await eventCount(handle.db)).toBe(0);
  });
});
