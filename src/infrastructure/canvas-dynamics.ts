import { sql, type Kysely } from 'kysely';
import { canvasDynamicsPoints, dynamicsAt, dynamicsSampleDates, type RecordedSnapshot } from '../domain/progress/snapshot.ts';
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

async function columnPresent(db: Kysely<Database>, table: string, column: string): Promise<boolean> {
  const found = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `.execute(db);
  return found.rows.length > 0;
}

/** `undefined` — колонки связи ещё нет, прятать динамику не из чего. */
async function repositoryOf(db: Kysely<Database>, projectId: string): Promise<string | null | undefined> {
  if (!(await columnPresent(db, 'projects', 'repository_id'))) return undefined;
  const linked = await db
    .selectFrom('projects')
    .select(['repository_id'])
    .where('id', '=', projectId)
    .executeTakeFirst();
  const repositoryId = linked?.repository_id ?? null;
  if (repositoryId === null || repositoryId.trim().length === 0) return null;
  return repositoryId;
}

/**
 * Точки динамики канваса: снимки на даты выборки.
 * Дня без снимка в ряде нет. Без репозитория ряд пустой.
 * У подключённого репозитория пустая доля остаётся пустой.
 */
export async function loadCanvasDynamics(
  db: Kysely<Database>,
  projectId: string,
  canvasDate: string,
): Promise<readonly RecordedSnapshot[]> {
  if (!(await tablePresent(db, 'progress_snapshots'))) return [];
  const points = dynamicsAt(await loadProgressDynamics(db, projectId), dynamicsSampleDates(canvasDate));
  const repositoryId = await repositoryOf(db, projectId);
  if (repositoryId === undefined) return points;
  return canvasDynamicsPoints(repositoryId, points);
}
