import { DYNAMICS_POINTS, DYNAMICS_STEP } from '../../config/constants.ts';
import { EVENT_TYPES, emit, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { projectCalendarDate } from '../shared/project-time.ts';
import type { BacklogShare } from './backlog-share.ts';
import { previousCalendarDate } from './divergence.ts';
import { projectShareRatio } from './no-data.ts';

/** Снимок доли пишет система (A-32). */
export const SNAPSHOT_ACTOR_ID = 'system';

export const SNAPSHOT_ACTOR_ROLE = 'system';

export const SNAPSHOT_SOURCE = 'system';

export const SNAPSHOT_SUBJECT = 'ProgressSnapshot';

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Проект в момент снимка. Доля уже посчитана по issues его репозитория. */
export interface SnapshotProject {
  projectId: string;
  timezone: string;
  share: BacklogShare | null;
}

/** Решение записать снимок на календарные сутки проекта. */
export interface SnapshotDecision {
  projectId: string;
  progress: number | null;
  date: string;
  idempotencyKey: string;
}

/** Уже записанный снимок: дата суток и доля. Пустая доля — не ноль. */
export interface RecordedSnapshot {
  date: string;
  progress: number | null;
}

export interface SnapshotInsert {
  id: string;
  projectId: string;
  progress: number | null;
  createdAt: Date;
}

export interface SnapshotStore {
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  insert(row: SnapshotInsert): Promise<void>;
}

function projectIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new DomainError(DOMAIN_ERROR.PROJECT_ID_BLANK, 'У проекта есть id');
  return id;
}

function calendarDate(value: string): string {
  const date = value.trim();
  if (!CALENDAR_DAY.test(date)) throw new DomainError(DOMAIN_ERROR.SNAPSHOT_DATE, 'Дата снимка — календарный день');
  return date;
}

/** Доля снимка: число от нуля до единицы либо пусто. Пусто — не ноль. */
function progressOf(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DomainError(DOMAIN_ERROR.SNAPSHOT_PROGRESS, 'Доля снимка — число от нуля до единицы или пусто');
  }
  return value;
}

/** Ключ `progress.snapshot_taken`: проект и дата. Повтор в те же сутки не пишет второй факт. */
export function snapshotTakenKey(projectId: string, date: string): string {
  return `${EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN}+${projectIdOf(projectId)}+${calendarDate(date)}`;
}

/**
 * Снимки, которых ещё нет на календарные сутки проекта.
 * Доля — `projectShareRatio`: нет репозитория и пустой знаменатель дают пусто, не ноль.
 * Повтор ключа в набор не входит.
 */
export function dueSnapshots(
  projects: readonly SnapshotProject[],
  now: Date,
  takenKeys: ReadonlySet<string>,
): SnapshotDecision[] {
  const seen = new Set<string>();
  const due: SnapshotDecision[] = [];
  for (const project of projects) {
    const projectId = projectIdOf(project.projectId);
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    const date = projectCalendarDate(now, project.timezone);
    const idempotencyKey = snapshotTakenKey(projectId, date);
    if (takenKeys.has(idempotencyKey)) continue;
    due.push({
      projectId,
      progress: progressOf(projectShareRatio(project.share)),
      date,
      idempotencyKey,
    });
  }
  return due;
}

/**
 * Динамика строится из записанных снимков, по дате.
 * Повтор даты не переписывает уже стоящую долю.
 * Дня, которого нет во входе, в ряде нет.
 */
export function progressDynamics(snapshots: readonly RecordedSnapshot[]): RecordedSnapshot[] {
  const byDate = new Map<string, number | null>();
  for (const snapshot of snapshots) {
    const date = calendarDate(snapshot.date);
    if (byDate.has(date)) continue;
    byDate.set(date, progressOf(snapshot.progress));
  }
  return [...byDate.keys()].sort().map((date) => {
    const progress = byDate.get(date);
    return { date, progress: progress ?? null };
  });
}

function rewindDays(date: string, days: number): string {
  let cursor = date;
  let left = days;
  while (left > 0) {
    cursor = previousCalendarDate(cursor);
    left -= 1;
  }
  return cursor;
}

/**
 * Даты строки динамики: `DYNAMICS_POINTS` точек с шагом `DYNAMICS_STEP`.
 * Последняя — дата канваса, раньше неё — назад по шагу. Старые даты впереди.
 * Снимок на эти даты берёт `dynamicsAt`: пропущенный день соседним числом не заменяется.
 */
export function dynamicsSampleDates(anchor: string): string[] {
  if (DYNAMICS_POINTS < 1) return [];
  let cursor = calendarDate(anchor);
  const newestFirst: string[] = [cursor];
  let taken = 1;
  while (taken < DYNAMICS_POINTS) {
    cursor = rewindDays(cursor, DYNAMICS_STEP);
    newestFirst.push(cursor);
    taken += 1;
  }
  return newestFirst.reverse();
}

/**
 * Точки на заданных датах.
 * Даты без снимка пропускаются: соседнее число на пропуск не ставится.
 * Записанная пустая доля остаётся пустой.
 */
export function dynamicsAt(snapshots: readonly RecordedSnapshot[], dates: readonly string[]): RecordedSnapshot[] {
  const recorded = progressDynamics(snapshots);
  const byDate = new Map(recorded.map((point) => [point.date, point.progress]));
  const points: RecordedSnapshot[] = [];
  const seen = new Set<string>();
  for (const value of dates) {
    const date = calendarDate(value);
    if (seen.has(date)) continue;
    seen.add(date);
    if (!byDate.has(date)) continue;
    const progress = byDate.get(date);
    points.push({ date, progress: progress ?? null });
  }
  return points;
}

/**
 * Записать `progress.snapshot_taken` и строку снимка.
 * Повтор ключа второе событие не пишет и строку не меняет.
 */
export async function publishProgressSnapshot(
  store: SnapshotStore,
  journal: EventJournal,
  input: SnapshotDecision & { snapshotId: string; occurredAt: Date },
): Promise<{ applied: boolean; eventId: string }> {
  const snapshotId = input.snapshotId.trim();
  if (snapshotId.length === 0) throw new DomainError(DOMAIN_ERROR.SNAPSHOT_ID_BLANK, 'У снимка есть id');
  const projectId = projectIdOf(input.projectId);
  const date = calendarDate(input.date);
  const progress = progressOf(input.progress);
  const idempotencyKey = snapshotTakenKey(projectId, date);
  if (input.idempotencyKey !== idempotencyKey) {
    throw new DomainError(DOMAIN_ERROR.SNAPSHOT_DATE, 'ключ снимка — проект и дата');
  }
  const prior = await store.seen(idempotencyKey);
  if (prior !== null) return { applied: false, eventId: prior.eventId };
  const published = await emit(journal, {
    type: EVENT_TYPES.PROGRESS_SNAPSHOT_TAKEN,
    source: SNAPSHOT_SOURCE,
    idempotencyKey,
    payload: { project_id: projectId, progress, date },
    actor: { id: SNAPSHOT_ACTOR_ID, role: SNAPSHOT_ACTOR_ROLE },
    subject: { entity: SNAPSHOT_SUBJECT, id: snapshotId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') return { applied: false, eventId: published.row.id };
  await store.insert({ id: snapshotId, projectId, progress, createdAt: input.occurredAt });
  return { applied: true, eventId: published.row.id };
}
