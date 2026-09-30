import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { githubWriteCommands, recordGithubDelivery, type GithubDelivery, type MilestoneDelivery } from '../src/domain/github/delivery.ts';
import {
  defineMilestone,
  MILESTONE_STATE_CLOSED,
  MILESTONE_STATE_OPEN,
  milestoneDueOn,
  milestoneNaturalKey,
  type Milestone,
} from '../src/domain/github/milestone.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { acceptGithubWebhook } from '../src/github/webhook.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { mirrorGithubMilestone } from '../src/infrastructure/milestone-mirror.ts';
import { readEventsMigration, readMilestonesMigration, readProjectsMigration, readRepositoriesMigration } from '../src/infrastructure/migrate.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const repositoryId = '42';
const otherRepositoryId = '7';
const dueOn = '2026-10-09';
const dueStamp = '2026-10-09T23:39:01Z';
const secret = 'hook-secret';
const projectA = '00000000-0000-4000-8000-0000000000a1';
const projectB = '00000000-0000-4000-8000-0000000000a2';

const openMilestone: Milestone = {
  id: '00000000-0000-4000-8000-0000000000c1',
  repositoryId,
  milestoneNumber: 1,
  title: 'Pilot',
  state: MILESTONE_STATE_OPEN,
  dueOn,
};

const closedMilestone: Milestone = {
  id: '00000000-0000-4000-8000-0000000000c2',
  repositoryId: otherRepositoryId,
  milestoneNumber: 3,
  title: 'Сдано',
  state: MILESTONE_STATE_CLOSED,
  dueOn: null,
};

const WRITE_CALLS = [
  'issues.create',
  'issues.update',
  'issues.createComment',
  'pulls.create',
  'pulls.merge',
  'repos.createCommit',
  "method: 'POST'",
  "method: 'PATCH'",
  "method: 'PUT'",
  "method: 'DELETE'",
];

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function sourceOf(paths: string[]): string {
  return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
}

function milestoneDelivery(patch: Partial<MilestoneDelivery> = {}): MilestoneDelivery {
  return {
    kind: 'milestone',
    deliveryId: 'delivery-milestone',
    repositoryId,
    number: 1,
    title: 'Pilot',
    state: 'open',
    dueOn: dueStamp,
    senderLogin: 'ada',
    ...patch,
  };
}

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openMilestones(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readMilestonesMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  await sql`
    INSERT INTO repositories (id, owner, name)
    VALUES (${repositoryId}, 'acme', 'bot'), (${otherRepositoryId}, 'acme', 'api')
  `.execute(db);
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

async function deliver(db: Kysely<Database>, delivery: GithubDelivery): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const result = await recordGithubDelivery(createEventJournal(trx, silentLogger), clock, delivery);
    if (result.status === 'applied' && result.eventType === EVENT_TYPES.GITHUB_MILESTONE_CHANGED) {
      await mirrorGithubMilestone(trx, result.payload, randomUUID());
    }
  });
}

async function milestoneCount(db: Kysely<Database>): Promise<number> {
  const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM milestones`.execute(db);
  return Number(count.rows[0]?.n);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'milestones'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

async function insertMilestone(db: Kysely<Database>, milestone: Milestone): Promise<void> {
  const row = defineMilestone(milestone);
  await sql`
    INSERT INTO milestones (id, repository_id, milestone_number, title, state, due_on)
    VALUES (
      ${row.id}::uuid,
      ${row.repositoryId},
      ${row.milestoneNumber},
      ${row.title},
      ${row.state},
      ${row.dueOn}::date
    )
  `.execute(db);
}

describe('E-13 milestone — таблица milestones', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('поля milestone: id, репозиторий, номер, название, состояние и срок', async () => {
    expect(defineMilestone(openMilestone)).toEqual(openMilestone);
    expect(defineMilestone({ ...openMilestone, title: '  Pilot  ', dueOn: dueStamp }).dueOn).toBe(dueOn);
    expect(defineMilestone(closedMilestone).dueOn).toBeNull();
    expect(milestoneDueOn('  ')).toBeNull();
    expect(() => defineMilestone({ ...openMilestone, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.MILESTONE_ID_BLANK }),
    );
    expect(() => defineMilestone({ ...openMilestone, title: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.MILESTONE_TITLE_BLANK }),
    );
    expect(() => defineMilestone({ ...openMilestone, state: 'planned' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.MILESTONE_STATE }),
    );
    expect(() => defineMilestone({ ...openMilestone, milestoneNumber: 0 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.MILESTONE_NUMBER }),
    );
    expect(() => defineMilestone({ ...openMilestone, dueOn: 'вчера' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.MILESTONE_DUE_ON }),
    );
    expect(milestoneNaturalKey(' 42 ', 1)).toEqual({ repositoryId, milestoneNumber: 1 });

    const handle = await openMilestones();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'due_on',
      'id',
      'milestone_number',
      'repository_id',
      'state',
      'title',
    ]);
    expect(await columnNames(handle.db)).not.toContain('project_id');
    expect(await columnNames(handle.db)).not.toContain('task_id');
    await insertMilestone(handle.db, openMilestone);
    await insertMilestone(handle.db, closedMilestone);
    const rows = await sql<{
      id: string;
      repository_id: string;
      milestone_number: number;
      title: string;
      state: string;
      due_on: string | null;
    }>`
      SELECT
        id::text AS id,
        repository_id,
        milestone_number,
        title,
        state,
        due_on::text AS due_on
      FROM milestones
      ORDER BY milestone_number
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        id: openMilestone.id,
        repository_id: repositoryId,
        milestone_number: 1,
        title: 'Pilot',
        state: MILESTONE_STATE_OPEN,
        due_on: dueOn,
      },
      {
        id: closedMilestone.id,
        repository_id: otherRepositoryId,
        milestone_number: 3,
        title: 'Сдано',
        state: MILESTONE_STATE_CLOSED,
        due_on: null,
      },
    ]);
  });

  it('ключ — id; природный ключ — репозиторий и номер; срок и название держат constraint', async () => {
    const handle = await openMilestones();
    opened.push(handle);
    await insertMilestone(handle.db, openMilestone);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES (${openMilestone.id}::uuid, ${otherRepositoryId}, 9, 'Другой', 'open')
    `.execute(handle.db)).rejects.toThrow(/milestones_pkey|23505/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES ('00000000-0000-4000-8000-0000000000c3'::uuid, ${repositoryId}, 1, 'Дубль', 'open')
    `.execute(handle.db)).rejects.toThrow(/milestones_repository_number_unique|23505/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES ('00000000-0000-4000-8000-0000000000c4'::uuid, '99', 1, 'Нет репозитория', 'open')
    `.execute(handle.db)).rejects.toThrow(/milestones_repository_id_fkey|23503/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES ('00000000-0000-4000-8000-0000000000c5'::uuid, ${repositoryId}, 0, 'Ноль', 'open')
    `.execute(handle.db)).rejects.toThrow(/milestones_number_positive|23514/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES ('00000000-0000-4000-8000-0000000000c6'::uuid, ${repositoryId}, 2, '   ', 'open')
    `.execute(handle.db)).rejects.toThrow(/milestones_title_not_blank|23514/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state)
      VALUES ('00000000-0000-4000-8000-0000000000c7'::uuid, ${repositoryId}, 2, 'Этап', 'planned')
    `.execute(handle.db)).rejects.toThrow(/milestones_state|23514/);
    await expect(sql`
      INSERT INTO milestones (id, repository_id, milestone_number, title, state, due_on)
      VALUES ('00000000-0000-4000-8000-0000000000c8'::uuid, ${repositoryId}, 2, 'Срок', 'open', 'вчера')
    `.execute(handle.db)).rejects.toThrow(/date|invalid/);
    expect(await milestoneCount(handle.db)).toBe(1);
  });
});

describe('зеркало milestone по webhook', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-21 запись зеркала milestone не пишет в GitHub и не заводит задачу', async () => {
    expect(githubWriteCommands()).toEqual([]);
    const source = sourceOf([
      ...filesIn('src/github'),
      'src/domain/github/milestone.ts',
      'src/domain/github/milestone-mirror.ts',
      'src/infrastructure/milestone-mirror.ts',
    ]);
    for (const needle of WRITE_CALLS) expect(source).not.toContain(needle);
    expect(source).not.toContain('domain/tasks');
    const handle = await openMilestones();
    opened.push(handle);
    await deliver(handle.db, milestoneDelivery());
    const events = await sql<{ event_type: string }>`SELECT event_type FROM events`.execute(handle.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([EVENT_TYPES.GITHUB_MILESTONE_CHANGED]);
    expect(await columnNames(handle.db)).not.toContain('task_id');
    await sql`
      INSERT INTO projects (id, name, description, timezone, created_at)
      VALUES
        (${projectA}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
        (${projectB}::uuid, 'Бета', '', 'Europe/Moscow', now())
    `.execute(handle.db);
    expect(await milestoneCount(handle.db)).toBe(1);
  });

  it('INV-22 повтор доставки milestone не пишет второе событие и не меняет строку', async () => {
    const handle = await openMilestones();
    opened.push(handle);
    const first = Buffer.from(
      JSON.stringify({
        action: 'created',
        milestone: { number: 1, title: 'Pilot', state: 'open', due_on: dueStamp },
        repository: { id: 42 },
        sender: { login: 'ada' },
      }),
    );
    const signed = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const once = async (body: Buffer, deliveryId: string) =>
      handle.db.transaction().execute((trx) =>
        acceptGithubWebhook({
          secret,
          eventName: 'milestone',
          deliveryId,
          signature: signed(body),
          body,
          journal: createEventJournal(trx, silentLogger),
          clock,
          logger: silentLogger,
          applyMilestone: async (payload) => {
            await mirrorGithubMilestone(trx, payload, randomUUID());
          },
        }),
      );
    expect(await once(first, 'delivery-same')).toBe(200);
    const second = Buffer.from(
      JSON.stringify({
        action: 'edited',
        milestone: { number: 1, title: 'Другое', state: 'closed', due_on: null },
        repository: { id: 42 },
        sender: { login: 'ada' },
      }),
    );
    expect(await once(second, 'delivery-same')).toBe(200);
    expect(await milestoneCount(handle.db)).toBe(1);
    const rows = await sql<{ title: string; state: string; due_on: string | null; idempotency_key: string }>`
      SELECT m.title, m.state, m.due_on::text AS due_on, e.idempotency_key
      FROM milestones AS m
      JOIN events AS e ON e.event_type = ${EVENT_TYPES.GITHUB_MILESTONE_CHANGED}
    `.execute(handle.db);
    expect(rows.rows).toEqual([{ title: 'Pilot', state: 'open', due_on: dueOn, idempotency_key: 'delivery-same' }]);
    const forged = await acceptGithubWebhook({
      secret,
      eventName: 'milestone',
      deliveryId: 'delivery-forged',
      signature: signed(Buffer.from('{}')),
      body: first,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: silentLogger,
    });
    expect(forged).toBe(401);
    expect(await milestoneCount(handle.db)).toBe(1);
  });

  it('природный ключ — одна строка на репозиторий и номер, проект в неё не входит', async () => {
    const handle = await openMilestones();
    opened.push(handle);
    await deliver(handle.db, milestoneDelivery());
    const first = await sql<{ id: string }>`SELECT id::text AS id FROM milestones`.execute(handle.db);
    await deliver(handle.db, milestoneDelivery({
      deliveryId: 'delivery-edit',
      title: 'Pilot 2',
      state: 'closed',
      dueOn: null,
    }));
    expect(await milestoneCount(handle.db)).toBe(1);
    const edited = await sql<{ id: string; title: string; state: string; due_on: string | null }>`
      SELECT id::text AS id, title, state, due_on::text AS due_on FROM milestones
    `.execute(handle.db);
    expect(edited.rows[0]).toEqual({
      id: first.rows[0]?.id,
      title: 'Pilot 2',
      state: 'closed',
      due_on: null,
    });
    await deliver(handle.db, milestoneDelivery({
      deliveryId: 'delivery-other-repo',
      repositoryId: otherRepositoryId,
      title: 'Тот же номер',
    }));
    expect(await milestoneCount(handle.db)).toBe(2);
    const events = await sql<{ event_type: string; actor_id: string; subject_entity: string }>`
      SELECT event_type, actor_id, subject_entity FROM events ORDER BY created_at
    `.execute(handle.db);
    expect(events.rows.every((row) => row.event_type === EVENT_TYPES.GITHUB_MILESTONE_CHANGED)).toBe(true);
    expect(events.rows.every((row) => row.actor_id === 'ada')).toBe(true);
    expect(events.rows.every((row) => row.subject_entity === 'Milestone')).toBe(true);
    const broken = Buffer.from(JSON.stringify({ action: 'created', repository: { id: 42 } }));
    const rejected = await acceptGithubWebhook({
      secret,
      eventName: 'milestone',
      deliveryId: 'delivery-broken',
      signature: `sha256=${createHmac('sha256', secret).update(broken).digest('hex')}`,
      body: broken,
      journal: createEventJournal(handle.db, silentLogger),
      clock,
      logger: silentLogger,
    });
    expect(rejected).toBe(400);
    expect(await milestoneCount(handle.db)).toBe(2);
  });
});
