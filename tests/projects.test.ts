import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { defineProject, PROJECT_OWN, type Project } from '../src/domain/projects/project.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readProjectsMigration } from '../src/infrastructure/migrate.ts';

const alpha: Project = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Альфа',
  description: 'учёт команды',
  timezone: 'Europe/Moscow',
  chatId: null,
  createdAt: '2026-09-28T07:33:00.000Z',
};

const beta: Project = {
  id: '00000000-0000-4000-8000-000000000011',
  name: 'Бета',
  description: '',
  timezone: 'Asia/Yekaterinburg',
  chatId: '00000000-0000-4000-8000-0000000000aa',
  createdAt: '2026-09-28T08:00:00.000Z',
};

async function openProjects(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readProjectsMigration());
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

async function insertProject(db: Kysely<Database>, project: Project): Promise<void> {
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES (
      ${project.id}::uuid,
      ${project.name},
      ${project.description},
      ${project.timezone},
      ${project.chatId}::uuid,
      ${project.createdAt}::timestamptz
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('E-3 проект — таблица projects', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-3 поля проекта: id, имя, описание, таймзона, супергруппа, created_at', async () => {
    const project = defineProject(alpha);
    expect(project).toEqual(alpha);
    expect(project.chatId).toBeNull();

    const handle = await openProjects();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual([
      'chat_id',
      'created_at',
      'description',
      'id',
      'name',
      'timezone',
    ]);
    await insertProject(handle.db, project);
    await insertProject(handle.db, defineProject(beta));
    const rows = await sql<{ id: string; name: string; description: string; timezone: string; chat_id: string | null }>`
      SELECT id::text AS id, name, description, timezone, chat_id::text AS chat_id
      FROM projects
      ORDER BY name
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      {
        id: alpha.id,
        name: alpha.name,
        description: alpha.description,
        timezone: alpha.timezone,
        chat_id: null,
      },
      {
        id: beta.id,
        name: beta.name,
        description: '',
        timezone: beta.timezone,
        chat_id: beta.chatId,
      },
    ]);
  });

  it('E-3 ключ — id: второй проект с тем же id не пишется', async () => {
    const handle = await openProjects();
    opened.push(handle);
    await insertProject(handle.db, defineProject(alpha));
    const duplicate = insertProject(handle.db, defineProject({ ...beta, id: alpha.id }));
    await expect(duplicate).rejects.toThrow(/duplicate key|23505|projects_pkey/);
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM projects`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('E-3 имя и таймзона не пустые, описание может быть пустым, created_at обязателен', async () => {
    expect(() => defineProject({ ...alpha, name: '  ' })).toThrow(DomainError);
    expect(() => defineProject({ ...alpha, name: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_NAME_BLANK }),
    );
    expect(() => defineProject({ ...alpha, timezone: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK }),
    );
    expect(() => defineProject({ ...alpha, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_ID_BLANK }),
    );
    expect(() => defineProject({ ...alpha, createdAt: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_CREATED_AT_BLANK }),
    );
    expect(defineProject({ ...alpha, description: '' }).description).toBe('');

    const handle = await openProjects();
    opened.push(handle);
    await expect(insertProject(handle.db, { ...alpha, name: '   ' })).rejects.toThrow(/projects_name_not_blank|23514/);
    await expect(insertProject(handle.db, { ...alpha, timezone: ' ' })).rejects.toThrow(
      /projects_timezone_not_blank|23514/,
    );
    const missingCreatedAt = sql`
      INSERT INTO projects (id, name, description, timezone, chat_id)
      VALUES (${alpha.id}::uuid, ${alpha.name}, ${alpha.description}, ${alpha.timezone}, NULL)
    `.execute(handle.db);
    await expect(missingCreatedAt).rejects.toThrow(/created_at|23502/);
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM projects`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(0);
  });

  it('E-3 супергруппа не уникальна и может быть пустой', async () => {
    const handle = await openProjects();
    opened.push(handle);
    const chatId = beta.chatId;
    if (chatId === null) throw new Error('чат бета задан');
    await insertProject(handle.db, defineProject({ ...alpha, chatId }));
    await insertProject(handle.db, defineProject(beta));
    const rows = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM projects WHERE chat_id = ${chatId}::uuid
    `.execute(handle.db);
    expect(Number(rows.rows[0]?.n)).toBe(2);
  });
});

describe('L-5 задачи и роли у проекта свои', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('L-5 задачи и роли не колонки проекта: два проекта — две единицы учёта', async () => {
    const handle = await openProjects();
    opened.push(handle);
    const columns = await columnNames(handle.db);
    for (const own of PROJECT_OWN) expect(columns).not.toContain(own);
    expect(columns).not.toContain('repository_id');

    await insertProject(handle.db, defineProject(alpha));
    await insertProject(handle.db, defineProject({ ...beta, name: alpha.name }));
    const rows = await sql<{ id: string }>`SELECT id::text AS id FROM projects ORDER BY id`.execute(handle.db);
    expect(rows.rows.map((row) => row.id)).toEqual([alpha.id, beta.id]);
  });
});
