import { sql, type Kysely } from 'kysely';
import { dynamicsAt, dynamicsSampleDates, type RecordedSnapshot } from '../domain/progress/snapshot.ts';
import type { Database } from './database.ts';
import { loadProgressDynamics } from './progress-snapshot.ts';

async function tablePresent(db: Kysely<Database>, table: string): Promise<boolean> {
  const found = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `.execute(db);
  return found.rows.length > 0;
}

/**
 * Точки динамики канваса: снимки на даты выборки.
 * Дня без снимка в ряде нет. Пустая доля остаётся пустой.
 */
export async function loadCanvasDynamics(
  db: Kysely<Database>,
  projectId: string,
  canvasDate: string,
): Promise<RecordedSnapshot[]> {
  if (!(await tablePresent(db, 'progress_snapshots'))) return [];
  return dynamicsAt(await loadProgressDynamics(db, projectId), dynamicsSampleDates(canvasDate));
}
