import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineIssue,
  ISSUE_STATE_CLOSED,
  ISSUE_STATE_OPEN,
  ISSUE_STATE_REASON_COMPLETED,
  ISSUE_STATE_REASON_NOT_PLANNED,
  type Issue,
} from '../src/domain/github/issue.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readIssuesMigration, readRepositoriesMigration } from '../src/infrastructure/migrate.ts';

const repositoryId = '42';
const otherRepositoryId = '7';
const updatedAt = '2026-09-28T07:33:00.000Z';
const closedAt = '2026-09-28T18:00:00.000Z';

const openIssue: Issue = {
  id: '00000000-0000-4000-8000-0000000000f1',
  repositoryId,
  issueNumber: 12,
  title: 'Починить датчик',
  state: ISSUE_STATE_OPEN,
  stateReason: null,
  closedByLogin: null,
  updatedAt,
  closedAt: null,
};

const completedIssue: Issue = {
  id: '00000000-0000-4000-8000-0000000000f2',
  repositoryId: otherRepositoryId,
  issueNumber: 3,
  title: 'Сдать отчёт',
  state: ISSUE_STATE_CLOSED,
  stateReason: ISSUE_STATE_REASON_COMPLETED,
  closedByLogin: 'anya',
  updatedAt: closedAt,
  closedAt,
};

interface IssueRow {
  id: string;
  repositoryId: string;
  issueNumber: number;
  title: string;
  state: string;
  stateReason: string | null;
  closedByLogin: string | null;
  updatedAt: string;
  closedAt: string | null;
}

async function openIssues(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readIssuesMigration());
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
    INSERT INTO repositories (id, owner, name)
    VALUES (${repositoryId}, 'acme', 'bot'), (${otherRepositoryId}, 'acme', 'api')
  `.execute(db);
}

async function insertIssue(db: Kysely<Database>, issue: IssueRow): Promise<void> {
  await sql`
    INSERT INTO issues (
      id, repository_id, issue_number, title, state, state_reason, closed_by_login, updated_at, closed_at
    )
    VALUES (
      ${issue.id}::uuid,
      ${issue.repositoryId},
      ${issue.issueNumber},
      ${issue.title},
      ${issue.state},
      ${issue.stateReason},
      ${issue.closedByLogin},
      ${issue.updatedAt}::timestamptz,
      ${issue.closedAt}::timestamptz
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'issues'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

function stamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

describe('E-10 issue — таблица issues', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-10 поля issue: id, репозиторий, номер, название, состояние, причина, кто закрыл и даты', async () => {
    const issue = defineIssue(openIssue);
    expect(issue).toEqual(openIssue);
    expect(issue.stateReason).toBeNull();
    expect(issue.closedAt).toBeNull();
    expect(defineIssue({ ...completedIssue, title: '  Сдать отчёт  ', closedByLogin: ' anya ' })).toEqual(completedIssue);
    expect(defineIssue({ ...completedIssue, stateReason: ISSUE_STATE_REASON_NOT_PLANNED }).stateReason).toBe(
      ISSUE_STATE_REASON_NOT_PLANNED,
    );

    const handle = await openIssues();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'closed_at',
      'closed_by_login',
      'id',
      'issue_number',
      'repository_id',
      'state',
      'state_reason',
      'title',
      'updated_at',
    ]);
    await seed(handle.db);
    await insertIssue(handle.db, issue);
    await insertIssue(handle.db, defineIssue(completedIssue));
    const rows = await sql<{
      id: string;
      repository_id: string;
      issue_number: number;
      title: string;
      state: string;
      state_reason: string | null;
      closed_by_login: string | null;
      updated_at: Date;
      closed_at: Date | null;
    }>`
      SELECT
        id::text AS id,
        repository_id,
        issue_number,
        title,
        state,
        state_reason,
        closed_by_login,
        updated_at,
        closed_at
      FROM issues
      ORDER BY issue_number
    `.execute(handle.db);
    const storedOpen = rows.rows.find((row) => row.id === openIssue.id);
    const storedClosed = rows.rows.find((row) => row.id === completedIssue.id);
    expect(storedOpen).toMatchObject({
      id: openIssue.id,
      repository_id: repositoryId,
      issue_number: openIssue.issueNumber,
      title: openIssue.title,
      state: ISSUE_STATE_OPEN,
      state_reason: null,
      closed_by_login: null,
    });
    expect(stamp(storedOpen?.updated_at ?? null)).toBe(updatedAt);
    expect(stamp(storedOpen?.closed_at ?? null)).toBeNull();
    expect(storedClosed).toMatchObject({
      id: completedIssue.id,
      repository_id: otherRepositoryId,
      issue_number: completedIssue.issueNumber,
      title: completedIssue.title,
      state: ISSUE_STATE_CLOSED,
      state_reason: ISSUE_STATE_REASON_COMPLETED,
      closed_by_login: 'anya',
    });
    expect(stamp(storedClosed?.closed_at ?? null)).toBe(closedAt);
  });

  it('E-10 ключ — id; репозиторий обязателен и ссылается на зеркало', async () => {
    const handle = await openIssues();
    opened.push(handle);
    await seed(handle.db);
    await insertIssue(handle.db, defineIssue(openIssue));
    await expect(insertIssue(handle.db, defineIssue({ ...completedIssue, id: openIssue.id }))).rejects.toThrow(
      /duplicate key|23505|issues_pkey/,
    );

    const missingRepository = sql`
      INSERT INTO issues (id, issue_number, title, state, updated_at)
      VALUES (
        ${completedIssue.id}::uuid,
        ${completedIssue.issueNumber},
        ${completedIssue.title},
        ${ISSUE_STATE_OPEN},
        ${updatedAt}::timestamptz
      )
    `.execute(handle.db);
    await expect(missingRepository).rejects.toThrow(/repository_id|23502/);

    const unknownRepository = insertIssue(handle.db, { ...completedIssue, repositoryId: '99' });
    await expect(unknownRepository).rejects.toThrow(/issues_repository_id_fkey|23503/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('E-10 номер, название и состояние заданы; причина — completed или not_planned и пуста у открытого', async () => {
    expect(() => defineIssue({ ...openIssue, id: ' ' })).toThrow(DomainError);
    expect(() => defineIssue({ ...openIssue, id: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ID_BLANK }));
    expect(() => defineIssue({ ...openIssue, repositoryId: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REPOSITORY_ID }),
    );
    expect(() => defineIssue({ ...openIssue, repositoryId: '0' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REPOSITORY_ID }),
    );
    expect(() => defineIssue({ ...openIssue, issueNumber: 0 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_NUMBER }),
    );
    expect(() => defineIssue({ ...openIssue, issueNumber: 1.5 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_NUMBER }),
    );
    expect(() => defineIssue({ ...openIssue, title: '   ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_TITLE_BLANK }),
    );
    expect(() => defineIssue({ ...openIssue, state: ' ' })).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE }));
    expect(() => defineIssue({ ...openIssue, state: 'merged' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE }),
    );
    expect(() => defineIssue({ ...openIssue, stateReason: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
    expect(() => defineIssue({ ...openIssue, stateReason: ISSUE_STATE_REASON_COMPLETED })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
    expect(() => defineIssue({ ...completedIssue, stateReason: 'reopened' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
    expect(defineIssue({ ...completedIssue, stateReason: null }).stateReason).toBeNull();
    expect(() => defineIssue({ ...completedIssue, closedByLogin: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_CLOSED_BY_LOGIN }),
    );
    expect(() => defineIssue({ ...openIssue, updatedAt: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_UPDATED_AT }),
    );
    expect(() => defineIssue({ ...openIssue, updatedAt: 'вчера' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_UPDATED_AT }),
    );
    expect(() => defineIssue({ ...completedIssue, closedAt: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_CLOSED_AT }),
    );

    const handle = await openIssues();
    opened.push(handle);
    await seed(handle.db);
    await insertIssue(handle.db, defineIssue({ ...completedIssue, stateReason: null, closedByLogin: null, closedAt: null }));
    await expect(insertIssue(handle.db, { ...openIssue, issueNumber: 0 })).rejects.toThrow(
      /issues_issue_number_positive|23514/,
    );
    await expect(insertIssue(handle.db, { ...openIssue, title: '   ' })).rejects.toThrow(/issues_title_not_blank|23514/);
    await expect(insertIssue(handle.db, { ...openIssue, state: 'merged' })).rejects.toThrow(/issues_state|23514/);
    await expect(
      insertIssue(handle.db, { ...openIssue, stateReason: ISSUE_STATE_REASON_COMPLETED }),
    ).rejects.toThrow(/issues_open_without_reason|23514/);
    await expect(insertIssue(handle.db, { ...completedIssue, id: openIssue.id, stateReason: 'reopened' })).rejects.toThrow(
      /issues_state_reason|23514/,
    );
    await expect(insertIssue(handle.db, { ...completedIssue, closedByLogin: '   ' })).rejects.toThrow(
      /issues_closed_by_login|23514/,
    );

    const missingUpdatedAt = sql`
      INSERT INTO issues (id, repository_id, issue_number, title, state)
      VALUES (
        ${openIssue.id}::uuid,
        ${repositoryId},
        ${openIssue.issueNumber},
        ${openIssue.title},
        ${ISSUE_STATE_OPEN}
      )
    `.execute(handle.db);
    await expect(missingUpdatedAt).rejects.toThrow(/updated_at|23502/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM issues`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });
});
