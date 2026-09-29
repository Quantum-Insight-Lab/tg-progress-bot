import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { backlogShare } from '../src/domain/progress/backlog-share.ts';
import {
  milestoneProgress,
  projectRepositoryReadings,
  type IssueRow,
  type MilestoneFacts,
  type ProjectMemberSlice,
} from '../src/domain/progress/repository-share.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readIssuesMigration,
  readMilestonesMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { loadProjectRepositoryReadings } from '../src/infrastructure/repository-share.ts';

const repoId = '42';
const otherRepoId = '7';

const open = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'open',
  stateReason: null,
});

const completed = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'closed',
  stateReason: 'completed',
});

const dropped = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'closed',
  stateReason: 'not_planned',
});

const repoIssues: IssueRow[] = [
  open(repoId, 1),
  completed(repoId, 2),
  open(repoId, 3),
  dropped(repoId, 4),
];

const otherIssues: IssueRow[] = [completed(otherRepoId, 1)];

const alpha: ProjectMemberSlice = {
  projectId: 'alpha',
  repositoryId: repoId,
  memberKeys: ['pull_request:8'],
};

const beta: ProjectMemberSlice = {
  projectId: 'beta',
  repositoryId: repoId,
  memberKeys: ['commit:abc', 'closed_issue:2'],
};

const gamma: ProjectMemberSlice = {
  projectId: 'gamma',
  repositoryId: null,
  memberKeys: [],
};

const delta: ProjectMemberSlice = {
  projectId: 'delta',
  repositoryId: otherRepoId,
  memberKeys: ['pull_request:1'],
};

const milestone: MilestoneFacts = {
  repositoryId: repoId,
  milestoneNumber: 3,
  title: 'Спринт',
  dueOn: '2026-10-01',
};

describe('доля живёт на репозитории', () => {
  it('INV-03 два проекта одного репозитория читают одну долю, участники её не двигают', () => {
    const readings = projectRepositoryReadings([alpha, beta, gamma, delta], [...repoIssues, ...otherIssues]);
    const first = readings[0];
    const second = readings[1];
    const third = readings[2];
    const fourth = readings[3];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) return;

    expect(first.repositoryId).toBe(repoId);
    expect(second.repositoryId).toBe(repoId);
    expect(first.share).toBe(second.share);
    expect(first.lineup).toBe(second.lineup);
    expect(first.share).toEqual({ completed: 1, remaining: 2, ratio: 1 / 3 });
    expect(first.lineup.map((issue) => issue.issueNumber)).toEqual([1, 2, 3, 4]);
    expect(first.memberKeys).toEqual(['pull_request:8']);
    expect(second.memberKeys).toEqual(['commit:abc', 'closed_issue:2']);
    expect(first.memberKeys).not.toEqual(second.memberKeys);

    expect(third.share).toBeNull();
    expect(third.lineup).toEqual([]);
    expect(third.repositoryId).toBeNull();

    expect(fourth.share).toEqual({ completed: 1, remaining: 0, ratio: 1 });
    expect(fourth.share).not.toBe(first.share);
    expect(fourth.lineup.map((issue) => issue.issueNumber)).toEqual([1]);
  });

  it('INV-03 линейка — issues всего репозитория, у milestone отдельного процента нет', () => {
    const readings = projectRepositoryReadings([alpha], repoIssues);
    const reading = readings[0];
    expect(reading).toBeDefined();
    if (reading === undefined || reading.share === null) return;

    const milestoneSlice = backlogShare([open(repoId, 1), completed(repoId, 2), dropped(repoId, 4)]);
    expect(milestoneSlice).toEqual({ completed: 1, remaining: 1, ratio: 1 / 2 });
    expect(reading.share).not.toEqual(milestoneSlice);
    expect(reading.lineup).toHaveLength(4);
    expect(reading.share).toEqual(backlogShare(repoIssues));

    expect(milestoneProgress(milestone)).toBeNull();
    expect(Object.keys(milestone).sort()).toEqual(['dueOn', 'milestoneNumber', 'repositoryId', 'title']);

    expect(() =>
      projectRepositoryReadings([alpha], [open(repoId, 1), open(repoId, 1)]),
    ).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_NUMBER }));
  });

  it('INV-01 доля одного репозитория не делится по проектам и не режется milestone', () => {
    const shared = projectRepositoryReadings(
      [
        { ...alpha, memberKeys: ['anya'] },
        { ...beta, memberKeys: [] },
      ],
      repoIssues,
    );
    expect(shared[0]?.share).toEqual(shared[1]?.share);
    expect(shared[0]?.share).toEqual(backlogShare(repoIssues));
    expect(milestoneProgress(milestone)).toBeNull();
  });
});

describe('доля из таблицы issues', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-01 доля считается из таблицы issues, задача её не двигает', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);

    const projects = [alpha, beta, delta];
    const before = await loadProjectRepositoryReadings(handle.db, projects);
    expect(before[0]?.share).toEqual({ completed: 1, remaining: 2, ratio: 1 / 3 });
    expect(before[0]?.share).toBe(before[1]?.share);
    expect(before[0]?.lineup.map((issue) => issue.issueNumber)).toEqual([1, 2, 3, 4]);
    expect(before[0]?.memberKeys).not.toEqual(before[1]?.memberKeys);
    expect(before[2]?.share).toEqual({ completed: 1, remaining: 0, ratio: 1 });

    await sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at, completed_at)
      VALUES (
        '00000000-0000-4000-8000-0000000000a1'::uuid,
        '00000000-0000-4000-8000-000000000010'::uuid,
        1,
        'Закрыть день',
        'DONE',
        'normal',
        '00000000-0000-4000-8000-000000000001'::uuid,
        '2026-09-28T07:33:00.000Z'::timestamptz,
        '2026-09-28T07:33:00.000Z'::timestamptz,
        '2026-09-28T07:33:00.000Z'::timestamptz
      )
    `.execute(handle.db);

    const after = await loadProjectRepositoryReadings(handle.db, projects);
    expect(after[0]?.share).toEqual(before[0]?.share);
    expect(after[1]?.share).toEqual(before[1]?.share);
    expect(after[2]?.share).toEqual(before[2]?.share);
  });

  it('INV-03 зеркало issues одно на репозиторий, у milestone колонки процента нет', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);

    const issueColumns = await columnNames(handle.db, 'issues');
    expect(issueColumns).toContain('repository_id');
    expect(issueColumns).not.toContain('project_id');
    expect(issueColumns).not.toContain('milestone_id');

    const milestoneColumns = await columnNames(handle.db, 'milestones');
    expect(milestoneColumns).toContain('title');
    expect(milestoneColumns).toContain('due_on');
    expect(milestoneColumns).not.toContain('progress');
    expect(milestoneColumns).not.toContain('percent');
    expect(milestoneColumns).not.toContain('ratio');

    const projectColumns = await columnNames(handle.db, 'projects');
    expect(projectColumns).toContain('repository_id');
    expect(projectColumns).not.toContain('progress');

    const stored = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM issues WHERE repository_id = ${repoId}
    `.execute(handle.db);
    expect(Number(stored.rows[0]?.n)).toBe(4);

    const readings = await loadProjectRepositoryReadings(handle.db, [alpha, beta, gamma]);
    expect(readings[0]?.share).toBe(readings[1]?.share);
    expect(readings[2]?.share).toBeNull();
    expect(milestoneProgress(milestone)).toBeNull();
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
  await pglite.exec(readMilestonesMigration());
  await pglite.exec(readTasksMigration());
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
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES ('00000000-0000-4000-8000-000000000001'::uuid, 1001, 'Аня', true)
  `.execute(db);
  await sql`
    INSERT INTO repositories (id, owner, name)
    VALUES (${repoId}, 'lab', 'bot'), (${otherRepoId}, 'lab', 'other')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
    VALUES
      ('00000000-0000-4000-8000-000000000010'::uuid, 'Альфа', '', 'Europe/Moscow', '2026-09-28T07:33:00.000Z'::timestamptz, ${repoId}),
      ('00000000-0000-4000-8000-000000000011'::uuid, 'Бета', '', 'Europe/Moscow', '2026-09-28T07:33:00.000Z'::timestamptz, ${repoId}),
      ('00000000-0000-4000-8000-000000000012'::uuid, 'Гамма', '', 'Europe/Moscow', '2026-09-28T07:33:00.000Z'::timestamptz, NULL)
  `.execute(db);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f1', repoId, 1, 'open', null);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f2', repoId, 2, 'closed', 'completed');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f3', repoId, 3, 'open', null);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f4', repoId, 4, 'closed', 'not_planned');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f5', otherRepoId, 1, 'closed', 'completed');
  await sql`
    INSERT INTO milestones (id, repository_id, milestone_number, title, state, due_on)
    VALUES (
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      ${repoId},
      3,
      'Спринт',
      'open',
      '2026-10-01'
    )
  `.execute(db);
}

async function insertIssue(
  db: Kysely<Database>,
  id: string,
  repositoryId: string,
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
      ${repositoryId},
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

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const columns = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `.execute(db);
  return columns.rows.map((row) => row.column_name);
}
