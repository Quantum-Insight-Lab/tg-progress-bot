import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { DYNAMICS_POINTS, DYNAMICS_STEP } from '../src/config/constants.ts';
import { dynamicsAt, dynamicsSampleDates } from '../src/domain/progress/snapshot.ts';
import { calendarDaysBetween } from '../src/domain/shared/project-time.ts';
import { EVENT_TYPES, EVENT_VERSIONS } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { loadCanvasDynamics } from '../src/infrastructure/canvas-dynamics.ts';
import {
  readEventsMigration,
  readProgressSnapshotsMigration,
  readProjectsMigration,
} from '../src/infrastructure/migrate.ts';
import type { CanvasRichText } from '../src/projections/canvas-message.ts';
import { divergenceLineParagraphs } from '../src/projections/divergence-line.ts';
import { DYNAMICS_NO_DATA, dynamicsLineParagraphs, dynamicsLineText } from '../src/projections/dynamics-line.ts';
import { githubSectionParagraphs } from '../src/projections/github-line.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const projectId = '00000000-0000-4000-8000-0000000000a1';
const canvasDate = '2026-09-17';
const sample = ['2026-08-27', '2026-09-03', '2026-09-10', '2026-09-17'] as const;
const weekLine = '27.08 — 24% · 03.09 — 28% · 10.09 — 31% · 17.09 — 42%';

const points = [
  { date: '2026-08-27', progress: 0.24 },
  { date: '2026-09-03', progress: 0.28 },
  { date: '2026-09-10', progress: 0.31 },
  { date: '2026-09-17', progress: 0.42 },
];

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  return text.button.text;
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
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

async function insertSnapshot(
  db: Kysely<Database>,
  suffix: string,
  date: string,
  progress: number | null,
): Promise<void> {
  const snapshotId = `00000000-0000-4000-8000-0000000001${suffix}`;
  const eventId = `00000000-0000-4000-8000-0000000002${suffix}`;
  await sql`
    INSERT INTO progress_snapshots (id, project_id, progress, created_at)
    VALUES (${snapshotId}::uuid, ${projectId}::uuid, ${progress}, ${`${date}T12:00:00.000Z`}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO events (
      id, source, event_type, payload, created_at, idempotency_key,
      causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id
    ) VALUES (
      ${eventId}::uuid,
      'system',
      ${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN},
      ${JSON.stringify({ project_id: projectId, progress, date })}::jsonb,
      ${`${date}T12:00:00.000Z`}::timestamptz,
      ${`${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}+${projectId}+${date}`},
      NULL,
      NULL,
      ${EVENT_VERSIONS[EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN]},
      'system',
      'system',
      'ProgressSnapshot',
      ${snapshotId}
    )
  `.execute(db);
}

describe('строка динамики на канвасе', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-582 четыре точки с шагом в неделю', () => {
    expect(DYNAMICS_POINTS).toBe(sample.length);
    expect(dynamicsSampleDates(canvasDate)).toEqual([...sample]);
    for (let index = 1; index < sample.length; index += 1) {
      const earlier = sample[index - 1];
      const later = sample[index];
      if (earlier === undefined || later === undefined) throw new Error('точка выборки');
      expect(calendarDaysBetween(earlier, later)).toBe(DYNAMICS_STEP);
    }
    expect(dynamicsLineText(points)).toBe(weekLine);
    expect(dynamicsLineParagraphs(points)).toEqual([{ pieces: [{ kind: 'text', text: weekLine }] }]);
  });

  it('R-506 R-507 динамика — последние снимки доли одной строкой', () => {
    const prepared = prepareCanvasMessage({
      projectName: 'Общественный сенсор',
      canvasDate,
      sections: {
        github: githubSectionParagraphs(null),
        divergence: divergenceLineParagraphs(false),
        dynamics: dynamicsLineParagraphs(points),
      },
    });
    if (prepared.status !== 'ready') throw new Error('канвас не собрался');
    const lines = prepared.message.blocks.map((block) => visible(block.text));
    expect(lines.at(-1)).toBe(weekLine);
    expect(lines.filter((line) => line === weekLine)).toHaveLength(1);
    expect(dynamicsLineParagraphs([])).toEqual([]);
  });

  it('INV-02 пропуски динамики на канвасе не заполняются, пустая доля — «Нет данных», не 0%', async () => {
    const recorded = [
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-04', progress: 0.99 },
      { date: '2026-09-10', progress: 0.31 },
      { date: '2026-09-17', progress: 0.42 },
    ];
    const gapped = dynamicsAt(recorded, dynamicsSampleDates(canvasDate));
    expect(gapped).toEqual([
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-10', progress: 0.31 },
      { date: '2026-09-17', progress: 0.42 },
    ]);
    const gapLine = dynamicsLineText(gapped);
    expect(gapLine).toBe('27.08 — 24% · 10.09 — 31% · 17.09 — 42%');
    expect(gapLine).not.toContain('03.09');
    expect(gapLine).not.toContain('99');
    expect(gapLine).not.toContain('0%');

    const withEmpty = dynamicsLineText([
      { date: '2026-08-27', progress: 0.24 },
      { date: '2026-09-03', progress: null },
      { date: '2026-09-17', progress: 0 },
    ]);
    expect(withEmpty).toBe(`27.08 — 24% · 03.09 — ${DYNAMICS_NO_DATA} · 17.09 — 0%`);
    expect(withEmpty).not.toContain('03.09 — 0%');

    const handle = await openDb();
    opened.push(handle);
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', '2026-08-01T00:00:00.000Z'::timestamptz)
    `.execute(handle.db);
    await insertSnapshot(handle.db, '01', '2026-08-27', 0.24);
    await insertSnapshot(handle.db, '02', '2026-09-04', 0.99);
    await insertSnapshot(handle.db, '03', '2026-09-10', 0.31);
    await insertSnapshot(handle.db, '04', '2026-09-17', 0.42);
    expect(await loadCanvasDynamics(handle.db, projectId, canvasDate)).toEqual(gapped);

    await insertSnapshot(handle.db, '05', '2026-09-03', null);
    const loaded = await loadCanvasDynamics(handle.db, projectId, canvasDate);
    expect(loaded).toContainEqual({ date: '2026-09-03', progress: null });
    expect(dynamicsLineText(loaded)).toContain(`03.09 — ${DYNAMICS_NO_DATA}`);
    expect(dynamicsLineText(loaded)).not.toContain('03.09 — 0%');
    expect(dynamicsLineText(loaded)).not.toContain('99');
  });
});
