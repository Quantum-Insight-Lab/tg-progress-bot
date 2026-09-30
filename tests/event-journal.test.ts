import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emit,
  EventRejected,
  EVENT_TYPES,
  EVENT_VERSIONS,
  payloadSchemaByType,
  type EmitInput,
  type EventType,
  type PayloadByType,
} from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readEventsMigration } from '../src/infrastructure/migrate.ts';
import { captureLog, silentLogger } from './log-lines.ts';

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
    const journal = createEventJournal(handle.db, silentLogger);
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
    expect(await countEvents(handle.db)).toBe(2);
    const notices = await sql<{ event_type: string }>`
      SELECT event_type FROM events WHERE event_type = ${EVENT_TYPES.DELIVERY_DUPLICATE}
    `.execute(handle.db);
    expect(notices.rows).toHaveLength(1);
  });

  it('INV-22 повтор любого события реестра не меняет журнал', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db, silentLogger);
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
    const notices = specs.size - 1;
    expect(await countEvents(handle.db)).toBe(specs.size + notices);
  }, 30_000);

  it('INV-22 вторая вставка того же ключа нарушает уникальный constraint', async () => {
    const handle = await openJournal();
    opened.push(handle);
    await emit(
      createEventJournal(handle.db, silentLogger),
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
    const journal = createEventJournal(handle.db, silentLogger);
    await expect(emit(journal, command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, ''))).rejects.toBeInstanceOf(EventRejected);
    const blank = sql`INSERT INTO events (id, source, event_type, payload, created_at, idempotency_key, schema_version, actor_id, actor_role, subject_entity, subject_id)
      VALUES (gen_random_uuid(), 'telegram', 'task.checked', CAST(${'{}'} AS jsonb), CURRENT_TIMESTAMP, '', 1, 'actor-1', 'member', 'Task', 'subject-1')`.execute(handle.db);
    await expect(blank).rejects.toThrow(/check constraint|23514/);
    expect(await countEvents(handle.db)).toBe(0);
  });

  it('INV-22 схема payload отвергает факт до записи', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const journal = createEventJournal(handle.db, silentLogger);
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
    await emit(createEventJournal(handle.db, silentLogger), command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, 'delivery-4'));
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

const correlationId = '00000000-0000-4000-8000-00000000c0de';
const causationId = '00000000-0000-4000-8000-00000000ca5e';

const ID_NAMED = /(^|_)(id|ids|by)$/;

/** Каждая свободная строка реестра, которая по имени не ID, получает свою метку текста людей. */
function textSample(spec: unknown, key: string, marks: string[]): unknown {
  if (Array.isArray(spec)) return [textSample(spec[0], key, marks)];
  if (isRecord(spec)) return Object.fromEntries(Object.entries(spec).map(([field, value]) => [field, textSample(value, field, marks)]));
  if (typeof spec === 'string' && /^string(\[\])?( \| null)?$/.test(spec.trim()) && !ID_NAMED.test(key)) {
    const mark = `‹текст людей ${marks.length}›`;
    marks.push(mark);
    return spec.includes('[]') ? [mark] : mark;
  }
  return sample(spec);
}

describe('B-17 строка лога на каждое событие журнала', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-22 каждый тип реестра: запись — строка info, повтор по ключу — строка повтора с тем же ключом', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const log = captureLog();
    const journal = createEventJournal(handle.db, log.logger);
    const specs = payloadSpecs();
    expect(specs.size).toBe(Object.values(EVENT_TYPES).length);
    for (const type of Object.values(EVENT_TYPES)) {
      const payload = payloadFor(type, specs.get(type));
      const key = `log:${type}`;
      const input = { ...command(type, payload, key), correlationId, causationId };
      const recordedFrom = log.raw.length;
      const applied = await emit(journal, input);
      const envelope = {
        eventType: type,
        schemaVersion: EVENT_VERSIONS[type],
        idempotencyKey: key,
        subjectEntity: 'Task',
        subjectId: 'subject-1',
        correlationId,
        causationId,
      };
      expect(log.lines().slice(recordedFrom)).toEqual([
        expect.objectContaining({ level: 'info', step: 'event.recorded', eventId: applied.row.id, ...envelope }),
      ]);
      const repeatedFrom = log.raw.length;
      await emit(journal, { ...input, actor: { id: 'actor-2', role: 'member' } });
      const repeated = log.lines().slice(repeatedFrom);
      expect(repeated[0]).toEqual(expect.objectContaining({ level: 'info', step: 'event.duplicate', eventId: applied.row.id, ...envelope }));
      if (type === EVENT_TYPES.DELIVERY_DUPLICATE) {
        expect(repeated).toHaveLength(1);
        continue;
      }
      expect(repeated).toEqual([
        repeated[0],
        expect.objectContaining({
          level: 'info',
          step: 'event.recorded',
          eventType: EVENT_TYPES.DELIVERY_DUPLICATE,
          idempotencyKey: `duplicate:${key}`,
          causationId: applied.row.id,
        }),
      ]);
    }
  }, 30_000);

  it('B-17 из payload в строку идут ID и коды, текст людей — ни на каком уровне', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const log = captureLog({ level: 'debug' });
    const journal = createEventJournal(handle.db, log.logger);
    const specs = payloadSpecs();
    const marks: string[] = [];
    for (const type of Object.values(EVENT_TYPES)) {
      const parsed = payloadSchemaByType[type].safeParse(textSample(specs.get(type), '', marks));
      if (!parsed.success) throw new Error(`${type}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      const payload = parsed.data as PayloadByType[typeof type];
      await emit(journal, command(type, payload, `text:${type}`));
      await emit(journal, command(type, payload, `text:${type}`));
    }
    expect(marks.length).toBeGreaterThan(0);
    const output = log.raw.join('\n');
    for (const mark of marks) expect(output).not.toContain(mark);
    const created = log.steps('event.recorded').find((line) => line.eventType === EVENT_TYPES.TASK_CREATED);
    expect(created).toEqual(
      expect.objectContaining({
        'payload.task_id': '2026-01-02',
        'payload.project_id': '2026-01-02',
        'payload.number': 1,
        'payload.assignee_id': '2026-01-02',
        'payload.priority': 'high',
      }),
    );
    expect(created).not.toHaveProperty('payload.title');
    const declared = log.steps('event.recorded').find((line) => line.eventType === EVENT_TYPES.BLOCKER_DECLARED);
    expect(declared).toEqual(expect.objectContaining({ 'payload.blocker_id': '2026-01-02' }));
    expect(declared).not.toHaveProperty('payload.reason');
    const changed = log.steps('event.recorded').find((line) => line.eventType === EVENT_TYPES.PROJECT_SETTINGS_CHANGED);
    expect(changed).toEqual(expect.objectContaining({ 'payload.project_id': '2026-01-02', 'payload.field': 'name' }));
    expect(changed).not.toHaveProperty('payload.value');
  }, 30_000);

  it('INV-28 отказ схемы payload — строка warn: тип и путь поля без значения, журнал не тронут', async () => {
    const handle = await openJournal();
    opened.push(handle);
    const log = captureLog();
    const bad = { task_id: 987654, note: '‹причина человека›' } as unknown as PayloadByType[typeof EVENT_TYPES.TASK_CHECKED];
    const rejected = emit(createEventJournal(handle.db, log.logger), command(EVENT_TYPES.TASK_CHECKED, bad, 'refused-1'));
    await expect(rejected).rejects.toBeInstanceOf(EventRejected);
    expect(log.lines()).toEqual([
      {
        time: expect.any(String),
        level: 'warn',
        step: 'event.refused',
        eventType: EVENT_TYPES.TASK_CHECKED,
        paths: ['payload.task_id', 'payload.note'],
        codes: ['invalid_type', 'unrecognized_keys'],
      },
    ]);
    expect(log.raw.join('\n')).not.toContain('987654');
    expect(log.raw.join('\n')).not.toContain('причина человека');
    expect(await countEvents(handle.db)).toBe(0);
  });

  it('INV-28 отказ записи журнала — строка error с типом события и причиной', async () => {
    const pglite = new PGlite();
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
    opened.push({ close: () => db.destroy() });
    const log = captureLog();
    const failed = emit(createEventJournal(db, log.logger), command(EVENT_TYPES.TASK_CHECKED, { task_id: 'task-1' }, 'failed-1'));
    await expect(failed).rejects.toThrow(/events/);
    expect(log.lines()).toEqual([
      {
        time: expect.any(String),
        level: 'error',
        step: 'event.append_failed',
        eventType: EVENT_TYPES.TASK_CHECKED,
        idempotencyKey: 'failed-1',
        reason: expect.stringContaining('events'),
      },
    ]);
  });
});
