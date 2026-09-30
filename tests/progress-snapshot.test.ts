import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { backlogShare } from '../src/domain/progress/backlog-share.ts';
import {
  dynamicsAt,
  dueSnapshots,
  progressDynamics,
  snapshotTakenKey,
  type SnapshotProject,
} from '../src/domain/progress/snapshot.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { projectCalendarDate } from '../src/domain/shared/project-time.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readIssuesMigration,
  readProgressSnapshotsMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
} from '../src/infrastructure/migrate.ts';
import { loadProgressDynamics, takeProgressSnapshots } from '../src/infrastructure/progress-snapshot.ts';
import { createScheduler } from '../src/infrastructure/scheduler.ts';
import { silentLogger } from './log-lines.ts';

const repoId = '42';
const openOnlyId = '7';
const emptyId = '9';
const alphaId = '00000000-0000-4000-8000-0000000000a1';
const betaId = '00000000-0000-4000-8000-0000000000a2';
const utcId = '00000000-0000-4000-8000-0000000000a3';
const bareId = '00000000-0000-4000-8000-0000000000a4';
const zeroId = '00000000-0000-4000-8000-0000000000a5';
const emptyProjectId = '00000000-0000-4000-8000-0000000000a6';
const createdAt = '2026-09-27T07:33:00.000Z';
const now = new Date('2026-09-28T21:30:00.000Z');
const laterSameMoscowDay = new Date('2026-09-29T20:30:00.000Z');
const skippedToOctober = new Date('2026-09-30T21:30:00.000Z');

const half = backlogShare([
  { state: 'open', stateReason: null },
  { state: 'closed', stateReason: 'completed' },
  { state: 'closed', stateReason: 'not_planned' },
]);

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

interface StoredSnapshot {
  project_id: string;
  progress: number | string | null;
  created_at: Date | string;
}

interface StoredEvent {
  key: string;
  payload: unknown;
  subject_id: string;
}

function payloadOf(value: unknown): { project_id?: string; progress?: number | null; date?: string } {
  if (typeof value === 'string') return JSON.parse(value) as { project_id?: string; progress?: number | null; date?: string };
  if (value !== null && typeof value === 'object') return value as { project_id?: string; progress?: number | null; date?: string };
  return {};
}

function ratioOf(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  return Number(value);
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectRepositoryMigration());
  await pglite.exec(readIssuesMigration());
  await pglite.exec(readProgressSnapshotsMigration());
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
      ${createdAt}::timestamptz,
      NULL
    )
  `.execute(db);
}

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO repositories (id, owner, name)
    VALUES (${repoId}, 'lab', 'bot'), (${openOnlyId}, 'lab', 'open'), (${emptyId}, 'lab', 'empty')
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at, repository_id)
    VALUES
      (${alphaId}::uuid, 'Альфа', '', 'Europe/Moscow', ${createdAt}::timestamptz, ${repoId}),
      (${betaId}::uuid, 'Бета', '', 'Europe/Moscow', ${createdAt}::timestamptz, ${repoId}),
      (${utcId}::uuid, 'Ютс', '', 'UTC', ${createdAt}::timestamptz, ${repoId}),
      (${bareId}::uuid, 'Без репозитория', '', 'Europe/Moscow', ${createdAt}::timestamptz, NULL),
      (${zeroId}::uuid, 'Ноль', '', 'UTC', ${createdAt}::timestamptz, ${openOnlyId}),
      (${emptyProjectId}::uuid, 'Пусто', '', 'UTC', ${createdAt}::timestamptz, ${emptyId})
  `.execute(db);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f1', repoId, 1, 'open', null);
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f2', repoId, 2, 'closed', 'completed');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f3', repoId, 3, 'closed', 'not_planned');
  await insertIssue(db, '00000000-0000-4000-8000-0000000000f4', openOnlyId, 1, 'open', null);
}

async function rows(db: Kysely<Database>): Promise<StoredSnapshot[]> {
  const found = await sql<StoredSnapshot>`
    SELECT project_id::text AS project_id, progress, created_at
    FROM progress_snapshots
    ORDER BY project_id::text, created_at
  `.execute(db);
  return found.rows;
}

async function events(db: Kysely<Database>): Promise<StoredEvent[]> {
  const found = await sql<StoredEvent>`
    SELECT idempotency_key AS key, payload, subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}
    ORDER BY idempotency_key
  `.execute(db);
  return found.rows;
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const columns = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'progress_snapshots'
    ORDER BY column_name
  `.execute(db);
  return columns.rows.map((row) => row.column_name);
}

describe('снимок доли раз в сутки', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-01 снимок хранит долю issues репозитория, задачи и PR её не двигают', async () => {
    const moscow: SnapshotProject = { projectId: alphaId, timezone: 'Europe/Moscow', share: half };
    const sameRepo: SnapshotProject = { projectId: betaId, timezone: 'Europe/Moscow', share: half };
    const bare: SnapshotProject = { projectId: bareId, timezone: 'Europe/Moscow', share: null };
    const zero: SnapshotProject = {
      projectId: zeroId,
      timezone: 'UTC',
      share: backlogShare([{ state: 'open', stateReason: null }]),
    };
    const dropped: SnapshotProject = {
      projectId: emptyProjectId,
      timezone: 'UTC',
      share: backlogShare([{ state: 'closed', stateReason: 'not_planned' }]),
    };
    const due = dueSnapshots([moscow, sameRepo, bare, zero, dropped, moscow], now, new Set());
    expect(due.map((item) => item.progress)).toEqual([half.ratio, half.ratio, null, 0, null]);
    expect(due[0]?.progress).toBe(due[1]?.progress);
    expect(due[0]?.date).toBe('2026-09-29');
    expect(due[3]?.date).toBe(projectCalendarDate(now, 'UTC'));
    expect(due.map((item) => item.idempotencyKey)).toEqual([
      snapshotTakenKey(alphaId, '2026-09-29'),
      snapshotTakenKey(betaId, '2026-09-29'),
      snapshotTakenKey(bareId, '2026-09-29'),
      snapshotTakenKey(zeroId, '2026-09-28'),
      snapshotTakenKey(emptyProjectId, '2026-09-28'),
    ]);
    expect(() => progressDynamics([{ date: '2026-09-01', progress: 2 }])).toThrow(DomainError);
    expect(() => progressDynamics([{ date: '2026-09-01', progress: 2 }])).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.SNAPSHOT_PROGRESS }));

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    expect(await columnNames(handle.db)).toEqual(['created_at', 'id', 'progress', 'project_id']);
    await takeProgressSnapshots(handle.db, silentLogger, now); // pragma: allowlist secret
    const stored = await rows(handle.db);
    const byProject = new Map(stored.map((row) => [row.project_id, ratioOf(row.progress)]));
    expect(byProject.get(alphaId)).toBe(half.ratio);
    expect(byProject.get(betaId)).toBe(byProject.get(alphaId));
    expect(byProject.get(utcId)).toBe(half.ratio);
    expect(byProject.get(bareId)).toBeNull();
    expect(byProject.get(zeroId)).toBe(0);
    expect(byProject.get(emptyProjectId)).toBeNull();
    const facts = await events(handle.db);
    expect(facts).toHaveLength(stored.length);
    for (const fact of facts) {
      const payload = payloadOf(fact.payload);
      const row = stored.find((item) => item.project_id === payload.project_id);
      expect(payload.progress).toBe(row === undefined ? undefined : ratioOf(row.progress));
      expect(payload).not.toHaveProperty('task_id');
      expect(fact.subject_id.length).toBeGreaterThan(0);
    }
    const source = [
      join('src', 'domain', 'progress', 'snapshot.ts'),
      join('src', 'infrastructure', 'progress-snapshot.ts'),
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(source).not.toContain('tasks');
    expect(source).not.toContain('pull_requests');
    expect(source).not.toContain('commits');
    expect(source).not.toContain('UPDATE progress_snapshots');
    const outOfRange = sql`
      INSERT INTO progress_snapshots (id, project_id, progress, created_at)
      VALUES ('00000000-0000-4000-8000-0000000000c1'::uuid, ${alphaId}::uuid, 2, ${createdAt}::timestamptz)
    `.execute(handle.db);
    await expect(outOfRange).rejects.toThrow(/check constraint|23514/);
  });

  it('INV-02 пропуски динамики не заполняются соседними числами, пустая доля не становится нулём', async () => {
    const recorded = [
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-10', progress: 0.31 },
      { date: '2026-09-17', progress: 0.42 },
      { date: '2026-09-17', progress: 0.99 },
    ];
    expect(progressDynamics(recorded)).toEqual([
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-10', progress: 0.31 },
      { date: '2026-09-17', progress: 0.42 },
    ]);
    expect(dynamicsAt(recorded, ['2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17'])).toEqual([
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-10', progress: 0.31 },
      { date: '2026-09-17', progress: 0.42 },
    ]);
    expect(
      dynamicsAt(
        [
          { date: '2026-09-01', progress: 0.5 },
          { date: '2026-09-02', progress: null },
          { date: '2026-09-03', progress: 0.25 },
        ],
        ['2026-09-01', '2026-09-02', '2026-09-03'],
      ),
    ).toEqual([
      { date: '2026-09-01', progress: 0.5 },
      { date: '2026-09-02', progress: null },
      { date: '2026-09-03', progress: 0.25 },
    ]);

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    await takeProgressSnapshots(handle.db, silentLogger, now); // pragma: allowlist secret
    expect(await loadProgressDynamics(handle.db, bareId)).toEqual([{ date: '2026-09-29', progress: null }]);
    expect(await loadProgressDynamics(handle.db, zeroId)).toEqual([{ date: '2026-09-28', progress: 0 }]);
    await sql`
      UPDATE issues
      SET state = 'closed', state_reason = 'completed'
      WHERE repository_id = ${repoId} AND issue_number = 1
    `.execute(handle.db);
    await takeProgressSnapshots(handle.db, silentLogger, skippedToOctober); // pragma: allowlist secret
    const alpha = await loadProgressDynamics(handle.db, alphaId);
    expect(alpha).toEqual([
      { date: '2026-09-29', progress: half.ratio },
      { date: '2026-10-01', progress: 1 },
    ]);
    expect(dynamicsAt(alpha, ['2026-09-29', '2026-09-30', '2026-10-01'])).toEqual([
      { date: '2026-09-29', progress: half.ratio },
      { date: '2026-10-01', progress: 1 },
    ]);
  });

  it('INV-22 повтор суток проекта не пишет второй снимок и не меняет первый', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const clock: Clock = { now: () => now };
    const scheduler = createScheduler(clock);
    scheduler.register('A-32', (at) => takeProgressSnapshots(handle.db, silentLogger, at)); // pragma: allowlist secret
    await scheduler.run();
    const onceRows = await rows(handle.db);
    const onceEvents = await events(handle.db);
    expect(onceEvents.map((item) => item.key).sort()).toEqual(
      [
        snapshotTakenKey(alphaId, '2026-09-29'),
        snapshotTakenKey(betaId, '2026-09-29'),
        snapshotTakenKey(utcId, '2026-09-28'),
        snapshotTakenKey(bareId, '2026-09-29'),
        snapshotTakenKey(zeroId, '2026-09-28'),
        snapshotTakenKey(emptyProjectId, '2026-09-28'),
      ].sort(),
    );
    await sql`
      UPDATE issues
      SET state = 'closed', state_reason = 'completed'
      WHERE repository_id = ${repoId} AND issue_number = 1
    `.execute(handle.db);
    await scheduler.run();
    await takeProgressSnapshots(handle.db, silentLogger, now); // pragma: allowlist secret
    expect(await rows(handle.db)).toEqual(onceRows);
    expect(await events(handle.db)).toEqual(onceEvents);

    await takeProgressSnapshots(handle.db, silentLogger, laterSameMoscowDay); // pragma: allowlist secret
    const afterBoundary = await rows(handle.db);
    const alphaRows = afterBoundary.filter((row) => row.project_id === alphaId);
    const utcRows = afterBoundary.filter((row) => row.project_id === utcId);
    expect(alphaRows).toHaveLength(1);
    expect(ratioOf(alphaRows[0]?.progress ?? null)).toBe(half.ratio);
    expect(utcRows).toHaveLength(2);
    expect(utcRows.map((row) => ratioOf(row.progress))).toEqual([half.ratio, 1]);
    const utcFacts = (await events(handle.db)).filter((item) => item.key.includes(utcId));
    expect(utcFacts.map((item) => payloadOf(item.payload).date).sort()).toEqual(['2026-09-28', '2026-09-29']);

    const sample = onceRows[0];
    if (sample === undefined) throw new Error('снимок не записан');
    await expect(sql`UPDATE progress_snapshots SET progress = 1`.execute(handle.db)).rejects.toThrow(/permission denied|42501/);
    await expect(sql`DELETE FROM progress_snapshots`.execute(handle.db)).rejects.toThrow(/permission denied|42501/);
    expect(await rows(handle.db)).toEqual(afterBoundary);
  });
});
