import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { emit, EventRejected, EVENT_TYPES, payloadSchemaByType, type EmitInput, type EventType, type PayloadByType } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readEventsMigration } from '../src/infrastructure/migrate.ts';

const occurredAt = new Date('2026-01-02T03:04:05.000Z');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEventType(value: string): value is EventType {
  return (Object.values(EVENT_TYPES) as readonly string[]).includes(value);
}

function sample(spec: unknown): unknown {
  if (Array.isArray(spec)) {
    if (spec.length !== 1) throw new Error('список в схеме описывает ровно один элемент');
    return [sample(spec[0])];
  }
  if (isRecord(spec)) return Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, sample(value)]));
  if (typeof spec !== 'string') throw new Error(`неизвестный тип поля: ${JSON.stringify(spec)}`);
  const chosen = spec.split('|').map((part) => part.trim()).find((part) => part !== 'null') ?? 'null';
  if (chosen === 'null') return null;
  const values = /^enum\[(.+)\]$/.exec(chosen)?.[1];
  if (values !== undefined) return values.split(',')[0]?.trim();
  const item = /^(.+)\[\]$/.exec(chosen)?.[1];
  if (item !== undefined) return [sample(item)];
  switch (chosen) {
    case 'string':
    case 'date':
      return '2026-01-02';
    case 'time':
      return '09:00';
    case 'timestamp':
      return '2026-01-02T03:04:05.000Z';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000001';
    case 'int':
    case 'number':
      return 1;
    case 'bool':
      return false;
    default:
      throw new Error(`неизвестный тип поля: ${chosen}`);
  }
}

function payloadSpecs(): Map<EventType, unknown> {
  const root: unknown = parseYaml(readFileSync('contracts/event-registry.yaml', 'utf8'));
  if (!isRecord(root) || !Array.isArray(root.events)) throw new Error('реестр без events');
  const specs = new Map<EventType, unknown>();
  for (const event of root.events) {
    if (!isRecord(event) || typeof event.type !== 'string' || !isEventType(event.type)) continue;
    specs.set(event.type, event.payload);
  }
  return specs;
}

function payloadFor<T extends EventType>(type: T, spec: unknown): PayloadByType[T] {
  const parsed = payloadSchemaByType[type].safeParse(sample(spec));
  if (!parsed.success) throw new Error(`${type}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data as PayloadByType[T];
}

function command<T extends EventType>(type: T, payload: PayloadByType[T], idempotencyKey: string, actorId = 'actor-1'): EmitInput<T> {
  return {
    type,
    source: 'telegram',
    idempotencyKey,
    payload,
    actor: { id: actorId, role: 'member' },
    subject: { entity: 'Task', id: 'subject-1' },
    occurredAt,
    causationId: null,
    correlationId: null,
  };
}

async function openJournal(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
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

async function countEvents(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM events`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return path.endsWith('.ts') || path.endsWith('.sql') ? [path] : [];
  });
}

describe('INV-22 один факт применяется один раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-22 повтор того же ключа не создаёт второе событие и не меняет первое', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db);
    const firstPayload = {
      task_id: 'task-1',
      project_id: 'project-1',
      number: 1,
      title: 'первая',
      assignee_id: 'user-1',
      priority: 'normal' as const,
    };
    const first = await emit(journal, command(EVENT_TYPES.TASK_CREATED, firstPayload, 'delivery-1'));
    const second = await emit(
      journal,
      command(EVENT_TYPES.TASK_CREATED, { ...firstPayload, title: 'вторая' }, 'delivery-1', 'actor-2'),
    );
    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(second.row).toEqual(first.row);
    expect(second.row.payload).toEqual(firstPayload);
    expect(second.row.actorId).toBe('actor-1');
    expect(await countEvents(handle.db)).toBe(1);
  });

  it('INV-22 повтор любого события реестра не меняет журнал', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db);
    const specs = payloadSpecs();
    expect(specs.size).toBe(Object.values(EVENT_TYPES).length);
    for (const type of Object.values(EVENT_TYPES)) {
      const spec = specs.get(type);
      const payload = payloadFor(type, spec);
      const key = `once:${type}`;
      const applied = await emit(journal, command(type, payload, key));
      const duplicate = await emit(journal, command(type, payload, key, 'actor-2'));
      expect(applied.status).toBe('applied');
      expect(duplicate.status).toBe('duplicate');
      expect(duplicate.row).toEqual(applied.row);
    }
    expect(await countEvents(handle.db)).toBe(specs.size);
  }, 30_000);

  it('INV-22 вторая вставка того же ключа нарушает уникальный constraint', async () => {
    const handle = await openJournal();
    opened.push(handle);
    await emit(
      createEventJournal(handle.db),
      command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, 'delivery-2'),
    );
    const failed = sql`INSERT INTO events (id, source, event_type, payload, created_at, idempotency_key, causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id)
      SELECT gen_random_uuid(), source, event_type, payload, created_at, idempotency_key, causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id
      FROM events`.execute(handle.db);
    await expect(failed).rejects.toThrow(/duplicate key|23505/);
    expect(await countEvents(handle.db)).toBe(1);
  });

  it('INV-22 пустой ключ не применяется', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db);
    await expect(emit(journal, command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, ''))).rejects.toBeInstanceOf(EventRejected);
    const blank = sql`INSERT INTO events (id, source, event_type, payload, created_at, idempotency_key, schema_version, actor_id, actor_role, subject_entity, subject_id)
      VALUES (gen_random_uuid(), 'telegram', 'task.checked', CAST(${'{}'} AS jsonb), CURRENT_TIMESTAMP, '', 1, 'actor-1', 'member', 'Task', 'subject-1')`.execute(handle.db);
    await expect(blank).rejects.toThrow(/check constraint|23514/);
    expect(await countEvents(handle.db)).toBe(0);
  });

  it('INV-22 схема payload отвергает факт до записи', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db);
    const bad = {
      task_id: 'task-1',
      project_id: 'project-1',
      number: 1,
      title: 'первая',
      assignee_id: 'user-1',
      priority: 'urgent',
    } as unknown as PayloadByType[typeof EVENT_TYPES.TASK_CREATED];
    const rejected = emit(journal, command(EVENT_TYPES.TASK_CREATED, bad, 'delivery-3'));
    await expect(rejected).rejects.toBeInstanceOf(EventRejected);
    expect(await countEvents(handle.db)).toBe(0);
  });
});

describe('INV-28 журнал только дополняется', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-28 UPDATE и DELETE журнала запрещены правами роли', async () => {
    const handle = await openJournal();
    opened.push(handle);
    await emit(createEventJournal(handle.db), command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, 'delivery-4'));
    await expect(sql`UPDATE events SET source = 'hacked'`.execute(handle.db)).rejects.toThrow(/permission denied|42501/);
    await expect(sql`DELETE FROM events`.execute(handle.db)).rejects.toThrow(/permission denied|42501/);
    expect(await countEvents(handle.db)).toBe(1);
    const source = await sql<{ source: string }>`SELECT source FROM events`.execute(handle.db);
    expect(source.rows[0]?.source).toBe('telegram');
  });

  it('INV-28 запись в журнал есть только в append, правки строк нет', () => {
    const sources = [...filesUnder('src'), ...filesUnder('migrations')];
    const insert = sources.filter((path) => readFileSync(path, 'utf8').includes("insertInto('events')"));
    const rewrite = sources.filter((path) => /UPDATE\s+events|DELETE\s+FROM\s+events/.test(readFileSync(path, 'utf8')));
    const callers = sources.filter((path) => readFileSync(path, 'utf8').includes('.append('));
    expect(insert.map((path) => path.replaceAll('\\', '/'))).toEqual(['src/infrastructure/event-journal.ts']);
    expect(rewrite).toEqual([]);
    expect(callers.map((path) => path.replaceAll('\\', '/'))).toEqual(['src/events/emit.ts']);
  });
});
