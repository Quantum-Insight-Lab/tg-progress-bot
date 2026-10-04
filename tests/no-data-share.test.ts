import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
  backlogShare,
} from '../src/domain/progress/backlog-share.ts';
import { projectShareRatio } from '../src/domain/progress/no-data.ts';
import { CANVAS_DESTINATION_TOPIC, decideCanvasMove } from '../src/domain/tasks/place-canvas.ts';
import { decideStaleBlock } from '../src/domain/tasks/detect-blocker.ts';
import { TASK_PRIORITY_NORMAL, TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { defineTask } from '../src/domain/tasks/task.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readIssuesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import { loadProjectShareRatio } from '../src/infrastructure/repository-share.ts';
import { NO_DATA_SHARE, noDataShareParagraphs } from '../src/projections/backlog-line.ts';
import { renderCanvas, type CanvasRichMessage, type CanvasRichText } from '../src/projections/canvas-message.ts';
import { tasksBlockParagraphs } from '../src/projections/tasks-block.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const openIssue = { state: BACKLOG_ISSUE_OPEN, stateReason: null };
const completedIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_COMPLETED };
const droppedIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_NOT_PLANNED };

const projectId = '00000000-0000-4000-8000-000000000010';
const bareId = '00000000-0000-4000-8000-000000000011';
const repoId = '42';
const created = new Date('2026-09-27T20:00:00.000Z');
const now = new Date('2026-09-28T22:00:00.000Z');

const taskLine = {
  number: 1,
  title: 'Классификация сигнала',
  status: TASK_STATUS_IN_PROGRESS,
  day: 1,
  priority: TASK_PRIORITY_NORMAL,
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

function painted(ratio: number | null): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Альфа',
    canvasDate: '2026-09-28',
    sections: {
      backlog: noDataShareParagraphs(ratio),
      tasks: tasksBlockParagraphs([taskLine]),
    },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return linesOf(prepared.message);
}

describe('нет данных вместо процента', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-02 без репозитория и при пустом знаменателе числа нет, это не 0', () => {
    expect(projectShareRatio(null)).toBeNull();
    expect(projectShareRatio(backlogShare([]))).toBeNull();
    expect(projectShareRatio(backlogShare([droppedIssue]))).toBeNull();
    expect(projectShareRatio(backlogShare([openIssue]))).toBe(0);
    expect(projectShareRatio(backlogShare([completedIssue, openIssue]))).toBe(1 / 2);
    expect(noDataShareParagraphs(null)).toEqual([{ pieces: [{ kind: 'text', text: `░░░░░░░░░░ ${NO_DATA_SHARE}` }] }]);
    expect(noDataShareParagraphs(0)).toEqual([]);
  });

  it('INV-02 задачи, канвас и блокеры по тишине работают без репозитория и процента не создают', () => {
    const task = defineTask({
      id: '00000000-0000-4000-8000-0000000000b1',
      projectId,
      number: 1,
      title: 'Классификация сигнала',
      status: TASK_STATUS_IN_PROGRESS,
      priority: TASK_PRIORITY_NORMAL,
      assigneeId: '00000000-0000-4000-8000-000000000001',
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      completedAt: null,
    });
    expect('repositoryId' in task).toBe(false);
    const move = decideCanvasMove(
      CANVAS_DESTINATION_TOPIC,
      {
        timezone: 'Europe/Moscow',
        bound: true,
        telegramChatId: '-1001234567890',
        topicId: 42,
        existing: null,
      },
      now,
    );
    expect(move.kind).toBe('post');
    const stale = decideStaleBlock({
      status: task.status,
      taskId: task.id,
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: [],
      now,
    });
    expect(stale).not.toBeNull();
    expect(projectShareRatio(null)).toBeNull();
  });

  it('R-099 R-101 придуманного процента нет', () => {
    const lines = painted(null);
    expect(lines.join('\n')).not.toMatch(/%|\b0%/);
    expect(lines[1]).toBe(`░░░░░░░░░░ ${NO_DATA_SHARE}`);
  });

  it('R-100 реальное состояние неизвестно — «Нет данных»', () => {
    expect(painted(projectShareRatio(null))[1]).toBe('░░░░░░░░░░ Нет данных');
    expect(painted(projectShareRatio(backlogShare([droppedIssue])))[1]).toBe('░░░░░░░░░░ Нет данных');
  });

  it('R-177 задачи без репозитория остаются на канвасе', () => {
    const lines = painted(null);
    expect(lines).toContain('Задачи');
    expect(lines.some((line) => line.includes('Классификация сигнала'))).toBe(true);
    expect(lines[1]).toBe(`░░░░░░░░░░ ${NO_DATA_SHARE}`);
  });

  it('R-178 канвас без репозитория печатается', () => {
    const lines = painted(null);
    expect(lines[0]).toBe('ПРОЕКТ: Альфа · 28.09');
    expect(lines[1]).toBe(`░░░░░░░░░░ ${NO_DATA_SHARE}`);
  });

  it('R-179 блокеры по тишине процента не создают', () => {
    const stale = decideStaleBlock({
      status: TASK_STATUS_IN_PROGRESS,
      taskId: '00000000-0000-4000-8000-0000000000b1',
      createdAt: created,
      timezone: 'Europe/Moscow',
      marks: [],
      now,
    });
    expect(stale).not.toBeNull();
    expect(painted(null).join('\n')).not.toContain('%');
  });

  it('R-180 процента проекта нет', () => {
    const message = renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-28',
      sections: { backlog: noDataShareParagraphs(projectShareRatio(null)) },
    });
    expect(linesOf(message)).toEqual(['ПРОЕКТ: Альфа · 28.09', '░░░░░░░░░░ Нет данных']);
  });

  it('R-181 печатается «Нет данных»', () => {
    expect(painted(null)[1]).toBe('░░░░░░░░░░ Нет данных');
  });

  it('R-453 R-455 пустой знаменатель — не 0%', () => {
    const ratio = projectShareRatio(backlogShare([]));
    expect(ratio).toBeNull();
    expect(ratio).not.toBe(0);
    const lines = painted(ratio);
    expect(lines[1]).toBe('░░░░░░░░░░ Нет данных');
    expect(lines.join('\n')).not.toContain('0%');
  });

  it('INV-02 чтение доли: нет репозитория и пустой знаменатель — пусто, открытый issue — ноль', async () => {
    const bare = await openProjects();
    opened.push(bare);
    await insertProject(bare.db, projectId, null, false);
    expect(await loadProjectShareRatio(bare.db, projectId)).toBeNull();

    const full = await openMirror();
    opened.push(full);
    await insertProject(full.db, bareId, null, true);
    await insertProject(full.db, projectId, repoId, true);
    expect(await loadProjectShareRatio(full.db, bareId)).toBeNull();
    expect(await loadProjectShareRatio(full.db, projectId)).toBeNull();

    await insertIssue(full.db, '00000000-0000-4000-8000-0000000000f1', 1, 'closed', 'not_planned');
    expect(await loadProjectShareRatio(full.db, projectId)).toBeNull();

    await insertIssue(full.db, '00000000-0000-4000-8000-0000000000f2', 2, 'open', null);
    expect(await loadProjectShareRatio(full.db, projectId)).toBe(0);

    await insertIssue(full.db, '00000000-0000-4000-8000-0000000000f3', 3, 'closed', 'completed');
    expect(await loadProjectShareRatio(full.db, projectId)).toBe(1 / 2);
  });
});

async function openProjects(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
  return dbOf(pglite);
}

async function openMirror(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readIssuesMigration());
  return dbOf(pglite);
}

function dbOf(pglite: PGlite): { db: Kysely<Database>; close: () => Promise<void> } {
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function insertProject(db: Kysely<Database>, id: string, repositoryId: string | null, linked: boolean): Promise<void> {
  if (repositoryId !== null) {
    await sql`
      INSERT INTO repositories (id, owner, name)
      VALUES (${repositoryId}, 'lab', 'bot')
    `.execute(db);
  }
  if (linked) {
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
      VALUES (${id}::uuid, 'Альфа', '', 'Europe/Moscow', '2026-09-28T07:33:00.000Z'::timestamptz, ${repositoryId})
    `.execute(db);
    return;
  }
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at)
    VALUES (${id}::uuid, 'Альфа', '', 'Europe/Moscow', '2026-09-28T07:33:00.000Z'::timestamptz)
  `.execute(db);
}

async function insertIssue(
  db: Kysely<Database>,
  id: string,
  issueNumber: number,
  state: string,
  stateReason: string | null,
): Promise<void> {
  await sql`
    INSERT INTO issues (
      id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
    )
    VALUES (
      ${id}::uuid,
      ${repoId},
      ${issueNumber},
      'issue',
      ${state},
      ${stateReason},
      NULL,
      '2026-09-28T07:33:00.000Z'::timestamptz,
      NULL
    )
  `.execute(db);
}
