import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { STALL_LINE_DEFAULT_BRANCH, STALL_LINE_PULL_REQUEST, type StallLine } from '../src/domain/github/stall.ts';
import { TASK_STATUS_BLOCKED, TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { loadCanvasBlockers, selectCanvasBlockers } from '../src/infrastructure/canvas-blockers.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readBlockersMigration,
  readCiMirrorMigration,
  readEventsMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readPullRequestsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { renderCanvas, type CanvasRichMessage, type CanvasRichText } from '../src/projections/canvas-message.ts';
import {
  BLOCKERS_BLOCK_HEADING,
  BLOCKER_DEFAULT_BRANCH_CI,
  blockerPullRequestText,
  blockerReasonText,
  blockersBlockParagraphs,
  type BlockersBlock,
} from '../src/projections/blockers-block.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000011';
const borisId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const reasonTaskId = '00000000-0000-4000-8000-0000000000b1';
const silentTaskId = '00000000-0000-4000-8000-0000000000b2';
const otherTaskId = '00000000-0000-4000-8000-0000000000b3';
const movingTaskId = '00000000-0000-4000-8000-0000000000b4';
const now = new Date('2026-09-17T09:00:00.000Z');
const stalledAt = new Date('2026-09-14T09:00:00.000Z');

const reason = 'нет стабильного доступа к одному из источников данных';

const block: BlockersBlock = {
  reasons: [
    { taskNumber: 7, reason },
    { taskNumber: 8, reason: null },
    { taskNumber: 9, reason: '   ' },
  ],
  defaultBranchCiRed: true,
  pullRequests: [
    { pullRequestNumber: 138, ciRed: true },
    { pullRequestNumber: 140, ciRed: false },
  ],
};

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((item) => visible(item.text));
}

const canvas = renderCanvas({
  projectName: 'Общественный сенсор',
  canvasDate: '2026-09-17',
  sections: {
    tasks: [{ pieces: [{ kind: 'text', text: 'Задачи' }] }],
    plan: [{ pieces: [{ kind: 'text', text: 'План' }] }],
    blockers: blockersBlockParagraphs(block),
    github: [{ pieces: [{ kind: 'text', text: 'GitHub' }] }],
  },
});
const lines = linesOf(canvas);

describe('блок «Блокеры»', () => {
  it('R-499 Блокеры', () => {
    expect(lines).toContain(BLOCKERS_BLOCK_HEADING);
    expect(lines).toContain('Блокеры');
    expect(lines.indexOf('Блокеры')).toBeGreaterThan(lines.indexOf('План'));
    expect(lines.indexOf('Блокеры')).toBeLessThan(lines.indexOf('GitHub'));
    expect(lines.indexOf('Блокеры')).toBeGreaterThan(lines.indexOf('Задачи'));
  });

  it('R-500 причины его задач в BLOCKED', () => {
    expect(blockerReasonText({ taskNumber: 7, reason })).toBe(`7 — ${reason}`);
    expect(lines).toContain(`7 — ${reason}`);
    const body = lines.filter((line) => line !== 'Блокеры' && line.includes(reason));
    expect(body).toEqual([`7 — ${reason}`]);
  });

  it('R-264 пока его нет, строка не печатается', () => {
    expect(blockerReasonText({ taskNumber: 8, reason: null })).toBeNull();
    expect(blockerReasonText({ taskNumber: 9, reason: '   ' })).toBeNull();
    expect(lines).not.toContain('8 —');
    expect(lines.join('\n')).not.toMatch(/^8 —/m);
    const empty = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        blockers: blockersBlockParagraphs({ reasons: [{ taskNumber: 8, reason: null }], pullRequests: [], defaultBranchCiRed: false }),
      },
    });
    expect(linesOf(empty)).toEqual(['ПРОЕКТ: Общественный сенсор · 17.09']);
    expect(linesOf(empty).join('\n')).not.toContain('Блокеры');
  });

  it('R-501 его строки CI / PR из 2.3', () => {
    expect(blockerPullRequestText({ pullRequestNumber: 138, ciRed: true })).toBe('PR #138 без движения, CI красный');
    expect(blockerPullRequestText({ pullRequestNumber: 140, ciRed: false })).toBe('PR #140 без движения');
    expect(lines).toContain('PR #138 без движения, CI красный');
    expect(lines).toContain('PR #140 без движения');
    const red = lines.find((line) => line.startsWith('PR #138'));
    expect(red).toBe('PR #138 без движения, CI красный');
    expect(red?.split('\n')).toHaveLength(1);
  });

  it('R-268 отдельно от задач бот показывает факты застоя репозитория', () => {
    const stall = lines.filter((line) => line.startsWith('PR #') || line === BLOCKER_DEFAULT_BRANCH_CI);
    expect(stall).toEqual(['CI основной ветки красный', 'PR #138 без движения, CI красный', 'PR #140 без движения']);
    for (const line of stall) {
      expect(line).not.toMatch(/^\d+ —/);
      expect(line).not.toContain('7 —');
      expect(line).not.toContain(reason);
    }
    const taskParagraph = lines.find((line) => line.startsWith('7 —'));
    expect(taskParagraph).toBe(`7 — ${reason}`);
    expect(taskParagraph).not.toContain('PR #');
    expect(taskParagraph).not.toContain(BLOCKER_DEFAULT_BRANCH_CI);
  });

  it('R-503 красный CI основной git-ветки — отдельная строка', () => {
    expect(BLOCKER_DEFAULT_BRANCH_CI).toBe('CI основной ветки красный');
    expect(lines).toContain('CI основной ветки красный');
    const ci = lines.filter((line) => line === 'CI основной ветки красный');
    expect(ci).toHaveLength(1);
    const pr = lines.find((line) => line.startsWith('PR #138'));
    expect(pr).not.toBe('CI основной ветки красный');
    expect(pr).not.toContain('CI основной ветки');
    const without = blockersBlockParagraphs({ ...block, defaultBranchCiRed: false });
    const hidden = without.map((paragraph) => paragraph.pieces.map((piece) => (piece.kind === 'text' ? piece.text : '')).join(''));
    expect(hidden).not.toContain('CI основной ветки красный');
  });
});

describe('отбор строк блока «Блокеры»', () => {
  const linesOfStall: StallLine[] = [
    { kind: STALL_LINE_DEFAULT_BRANCH, projectId, repositoryId: '42' },
    { kind: STALL_LINE_DEFAULT_BRANCH, projectId: otherProjectId, repositoryId: '43' },
    {
      kind: STALL_LINE_PULL_REQUEST,
      projectId,
      repositoryId: '42',
      pullRequestNumber: 138,
      authorLogin: 'Boris',
      ciRed: true,
    },
    {
      kind: STALL_LINE_PULL_REQUEST,
      projectId,
      repositoryId: '42',
      pullRequestNumber: 200,
      authorLogin: 'other',
      ciRed: false,
    },
    {
      kind: STALL_LINE_PULL_REQUEST,
      projectId: otherProjectId,
      repositoryId: '43',
      pullRequestNumber: 201,
      authorLogin: 'boris',
      ciRed: true,
    },
  ];

  it('R-501 на канвасе только его PR и красный CI этого проекта', () => {
    const selected = selectCanvasBlockers({
      projectId,
      githubLogin: 'boris',
      reasons: [{ taskNumber: 7, reason }],
      lines: linesOfStall,
    });
    expect(selected.defaultBranchCiRed).toBe(true);
    expect(selected.pullRequests).toEqual([{ pullRequestNumber: 138, ciRed: true }]);
    expect(selected.reasons).toEqual([{ taskNumber: 7, reason }]);
  });

  it('R-264 причина без ответа в отбор печати не добавляет строку', () => {
    const selected = selectCanvasBlockers({
      projectId,
      githubLogin: null,
      reasons: [{ taskNumber: 8, reason: null }],
      lines: [],
    });
    expect(blockersBlockParagraphs(selected)).toEqual([]);
  });
});

describe('блок «Блокеры» читается из задач и зеркала', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    const fixture = opened.pop();
    if (fixture !== undefined) await fixture.close();
  });

  async function openDb(): Promise<Kysely<Database>> {
    const pglite = new PGlite();
    await pglite.exec(readEventsMigration());
    await pglite.exec(readUsersMigration());
    await pglite.exec(readProjectsMigration());
    await pglite.exec(readProjectMembersMigration());
    await pglite.exec(readRepositoriesMigration());
    await pglite.exec(readProjectRepositoryMigration());
    await pglite.exec(readTasksMigration());
    await pglite.exec(readBlockersMigration());
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
    return db;
  }

  it('R-500 R-264 R-501 R-503 строки исполнителя, без чужого PR и без причины', async () => {
    const db = await openDb();
    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root, github_login)
      VALUES
        (${borisId}::uuid, 1002, 'Борис', true, 'boris'),
        (${otherId}::uuid, 1003, 'Вера', false, 'vera')
    `.execute(db);
    await sql`
      INSERT INTO repositories (id, owner, name, default_branch_ci)
      VALUES ('42', 'org', 'sensor', 'failure'), ('43', 'org', 'other', 'failure')
    `.execute(db);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
      VALUES
        (${projectId}::uuid, 'Сенсор', '', 'Europe/Moscow', ${now.toISOString()}::timestamptz, '42'),
        (${otherProjectId}::uuid, 'Другой', '', 'Europe/Moscow', ${now.toISOString()}::timestamptz, '43')
    `.execute(db);
    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES
        ('00000000-0000-4000-8000-0000000000c1'::uuid, ${projectId}::uuid, ${borisId}::uuid, 'member'),
        ('00000000-0000-4000-8000-0000000000c2'::uuid, ${projectId}::uuid, ${otherId}::uuid, 'member'),
        ('00000000-0000-4000-8000-0000000000c3'::uuid, ${otherProjectId}::uuid, ${borisId}::uuid, 'member')
    `.execute(db);
    await sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES
        (${reasonTaskId}::uuid, ${projectId}::uuid, 7, 'Классификация', ${TASK_STATUS_BLOCKED}, 'normal', ${borisId}::uuid, ${stalledAt.toISOString()}::timestamptz, ${stalledAt.toISOString()}::timestamptz),
        (${silentTaskId}::uuid, ${projectId}::uuid, 8, 'Без ответа', ${TASK_STATUS_BLOCKED}, 'normal', ${borisId}::uuid, ${stalledAt.toISOString()}::timestamptz, ${stalledAt.toISOString()}::timestamptz),
        (${otherTaskId}::uuid, ${projectId}::uuid, 3, 'Чужая', ${TASK_STATUS_BLOCKED}, 'normal', ${otherId}::uuid, ${stalledAt.toISOString()}::timestamptz, ${stalledAt.toISOString()}::timestamptz),
        (${movingTaskId}::uuid, ${projectId}::uuid, 4, 'В работе', ${TASK_STATUS_IN_PROGRESS}, 'normal', ${borisId}::uuid, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
    `.execute(db);
    await sql`
      INSERT INTO blockers (id, task_id, reason, asked_at, resolved_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000e1'::uuid, ${reasonTaskId}::uuid, ${reason}, ${stalledAt.toISOString()}::timestamptz, NULL),
        ('00000000-0000-4000-8000-0000000000e2'::uuid, ${silentTaskId}::uuid, NULL, ${stalledAt.toISOString()}::timestamptz, NULL),
        ('00000000-0000-4000-8000-0000000000e3'::uuid, ${otherTaskId}::uuid, 'чужая причина', ${stalledAt.toISOString()}::timestamptz, NULL),
        ('00000000-0000-4000-8000-0000000000e4'::uuid, ${movingTaskId}::uuid, 'уже закрыт', ${stalledAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
    `.execute(db);
    await sql`
      INSERT INTO pull_requests (id, repository_id, pull_request_number, title, author_login, state, ci_status, updated_at)
      VALUES
        ('00000000-0000-4000-8000-0000000000d1'::uuid, '42', 138, 'долгий', 'boris', 'open', 'failure', ${stalledAt.toISOString()}::timestamptz),
        ('00000000-0000-4000-8000-0000000000d2'::uuid, '42', 200, 'веры', 'vera', 'open', 'failure', ${stalledAt.toISOString()}::timestamptz),
        ('00000000-0000-4000-8000-0000000000d3'::uuid, '42', 201, 'чужой', 'stranger', 'open', 'failure', ${stalledAt.toISOString()}::timestamptz),
        ('00000000-0000-4000-8000-0000000000d4'::uuid, '42', 139, 'свежий', 'boris', 'open', 'failure', ${now.toISOString()}::timestamptz)
    `.execute(db);

    const loaded = await loadCanvasBlockers(db, projectId, borisId, now);
    expect(loaded.reasons).toEqual([
      { taskNumber: 7, reason },
      { taskNumber: 8, reason: null },
    ]);
    expect(loaded.defaultBranchCiRed).toBe(true);
    expect(loaded.pullRequests).toEqual([{ pullRequestNumber: 138, ciRed: true }]);

    const painted = linesOf(
      renderCanvas({
        projectName: 'Общественный сенсор',
        canvasDate: '2026-09-17',
        sections: { blockers: blockersBlockParagraphs(loaded) },
      }),
    );
    expect(painted).toEqual([
      'ПРОЕКТ: Общественный сенсор · 17.09',
      'Блокеры',
      `7 — ${reason}`,
      'CI основной ветки красный',
      'PR #138 без движения, CI красный',
    ]);

    const statuses = await sql<{ number: number | string; status: string }>`
      SELECT number, status FROM tasks ORDER BY number
    `.execute(db);
    expect(statuses.rows.map((row) => ({ number: Number(row.number), status: row.status }))).toEqual([
      { number: 3, status: TASK_STATUS_BLOCKED },
      { number: 4, status: TASK_STATUS_IN_PROGRESS },
      { number: 7, status: TASK_STATUS_BLOCKED },
      { number: 8, status: TASK_STATUS_BLOCKED },
    ]);
  });
});
