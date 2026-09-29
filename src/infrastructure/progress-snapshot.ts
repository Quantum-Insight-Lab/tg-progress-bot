import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  dueSnapshots,
  progressDynamics,
  publishProgressSnapshot,
  type RecordedSnapshot,
  type SnapshotDecision,
  type SnapshotProject,
} from '../domain/progress/snapshot.ts';
import { EVENT_TYPES } from '../events/index.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';
import { loadProjectRepositoryReadings } from './repository-share.ts';

interface ProjectRow {
  id: string;
  timezone: string;
  repository_id: string | null;
}

interface SnapshotRow {
  date: string | null;
  progress: number | string | null;
}

function ratioOf(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  const text = value.trim();
  if (text.length === 0) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error('доля снимка повреждена');
  return parsed;
}

async function projectsOf(db: Kysely<Database>): Promise<SnapshotProject[]> {
  const found = await sql<ProjectRow>`
    SELECT id::text AS id, timezone, repository_id
    FROM projects
    ORDER BY id
  `.execute(db);
  const readings = await loadProjectRepositoryReadings(
    db,
    found.rows.map((row) => ({
      projectId: row.id,
      repositoryId: row.repository_id,
      memberKeys: [],
    })),
  );
  const share = new Map(readings.map((reading) => [reading.projectId, reading.share]));
  return found.rows.map((row) => ({
    projectId: row.id,
    timezone: row.timezone,
    share: share.get(row.id) ?? null,
  }));
}

async function takenKeys(db: Kysely<Database>): Promise<Set<string>> {
  const found = await sql<{ idempotency_key: string }>`
    SELECT idempotency_key
    FROM events
    WHERE event_type = ${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}
  `.execute(db);
  return new Set(found.rows.map((row) => row.idempotency_key));
}

async function publishOne(
  db: Kysely<Database>,
  decision: SnapshotDecision,
  now: Date,
): Promise<void> {
  const snapshotId = randomUUID();
  await db.transaction().execute(async (trx) => {
    await publishProgressSnapshot(
      {
        seen(idempotencyKey) {
          return trx
            .selectFrom('events')
            .select('id')
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst()
            .then((found) => (found === undefined ? null : { eventId: found.id }));
        },
        async insert(row) {
          await trx
            .insertInto('progress_snapshots')
            .values({
              id: row.id,
              project_id: row.projectId,
              progress: row.progress,
              created_at: row.createdAt,
            })
            .execute();
        },
      },
      createEventJournal(trx),
      { ...decision, snapshotId, occurredAt: now },
    );
  });
}

/**
 * A-32. На календарные сутки проекта пишет одну долю.
 * Повтор в те же сутки второе событие не пишет и строку не меняет.
 * Сбой одного проекта не отменяет остальные, затем всплывает.
 */
export async function takeProgressSnapshots(db: Kysely<Database>, now: Date): Promise<void> {
  const projects = await projectsOf(db);
  const taken = await takenKeys(db);
  const failures: unknown[] = [];
  for (const project of projects) {
    let decisions: SnapshotDecision[];
    try {
      decisions = dueSnapshots([project], now, taken);
    } catch (error) {
      failures.push(error);
      continue;
    }
    for (const decision of decisions) {
      try {
        await publishOne(db, decision, now);
        taken.add(decision.idempotencyKey);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 0) return;
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new Error('снимок доли не записан');
}

/**
 * Динамика проекта: только записанные снимки.
 * Дата — из факта суток, доля — из строки. Пропуск между датами не заполняется.
 */
export async function loadProgressDynamics(db: Kysely<Database>, projectId: string): Promise<RecordedSnapshot[]> {
  const found = await sql<SnapshotRow>`
    SELECT events.payload->>'date' AS date,
           progress_snapshots.progress AS progress
    FROM progress_snapshots
    JOIN events
      ON events.subject_id = progress_snapshots.id::text
     AND events.event_type = ${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}
    WHERE progress_snapshots.project_id = ${projectId}::uuid
    ORDER BY progress_snapshots.created_at
  `.execute(db);
  return progressDynamics(
    found.rows.map((row) => ({
      date: row.date ?? '',
      progress: ratioOf(row.progress),
    })),
  );
}
