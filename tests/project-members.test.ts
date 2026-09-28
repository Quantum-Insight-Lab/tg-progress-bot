import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineProjectMember,
  LEAD_ROLE,
  leadsTasks,
  MEMBER_ROLE,
  PROJECT_ROLES,
  type ProjectMember,
} from '../src/domain/projects/member.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import {
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';

const projectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000011';
const userId = '00000000-0000-4000-8000-000000000001';
const otherUserId = '00000000-0000-4000-8000-000000000002';

const executor: ProjectMember = {
  id: '00000000-0000-4000-8000-0000000000a1',
  projectId,
  userId,
  role: MEMBER_ROLE,
};

const manager: ProjectMember = {
  id: '00000000-0000-4000-8000-0000000000a2',
  projectId,
  userId: otherUserId,
  role: LEAD_ROLE,
};

async function openMembers(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
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

async function seed(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES
      (${userId}::uuid, 1001, 'Аня', true),
      (${otherUserId}::uuid, 1002, 'Борис', false)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
    VALUES
      (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, '2026-09-28T07:33:00.000Z'::timestamptz),
      (${otherProjectId}::uuid, 'Бета', '', 'Europe/Moscow', NULL, '2026-09-28T08:00:00.000Z'::timestamptz)
  `.execute(db);
}

async function insertMember(db: Kysely<Database>, member: ProjectMember): Promise<void> {
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (
      ${member.id}::uuid,
      ${member.projectId}::uuid,
      ${member.userId}::uuid,
      ${member.role}
    )
  `.execute(db);
}

async function columnNames(db: Kysely<Database>): Promise<string[]> {
  const result = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_members'
    ORDER BY column_name
  `.execute(db);
  return result.rows.map((row) => row.column_name);
}

describe('E-4 участник проекта — таблица project_members', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('E-4 поля участника: id, project_id, user_id, role', async () => {
    const member = defineProjectMember(executor);
    expect(member).toEqual(executor);

    const handle = await openMembers();
    opened.push(handle);
    expect(await columnNames(handle.db)).toEqual(['id', 'project_id', 'role', 'user_id']);
    await seed(handle.db);
    await insertMember(handle.db, member);
    await insertMember(handle.db, defineProjectMember(manager));
    const rows = await sql<{ id: string; project_id: string; user_id: string; role: string }>`
      SELECT id::text AS id, project_id::text AS project_id, user_id::text AS user_id, role
      FROM project_members
      ORDER BY role
    `.execute(handle.db);
    expect(rows.rows).toEqual([
      { id: manager.id, project_id: projectId, user_id: otherUserId, role: LEAD_ROLE },
      { id: executor.id, project_id: projectId, user_id: userId, role: MEMBER_ROLE },
    ]);
  });

  it('E-4 ключ — id, project_id и user_id обязательны и ссылаются на проект и пользователя', async () => {
    const handle = await openMembers();
    opened.push(handle);
    await seed(handle.db);
    await insertMember(handle.db, defineProjectMember(executor));
    await expect(insertMember(handle.db, defineProjectMember({ ...manager, id: executor.id }))).rejects.toThrow(
      /duplicate key|23505|project_members_pkey/,
    );

    const missingProject = sql`
      INSERT INTO project_members (id, user_id, role)
      VALUES (${manager.id}::uuid, ${otherUserId}::uuid, ${LEAD_ROLE})
    `.execute(handle.db);
    await expect(missingProject).rejects.toThrow(/project_id|23502/);

    const unknownProject = insertMember(handle.db, {
      ...manager,
      projectId: '00000000-0000-4000-8000-000000000099',
    });
    await expect(unknownProject).rejects.toThrow(/project_members_project_id_fkey|23503/);

    const unknownUser = insertMember(handle.db, {
      ...manager,
      userId: '00000000-0000-4000-8000-000000000098',
    });
    await expect(unknownUser).rejects.toThrow(/project_members_user_id_fkey|23503/);

    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM project_members`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('E-4 уникально project_id + user_id: тот же человек в другом проекте — вторая строка', async () => {
    const handle = await openMembers();
    opened.push(handle);
    await seed(handle.db);
    await insertMember(handle.db, defineProjectMember(executor));
    await expect(
      insertMember(handle.db, defineProjectMember({ ...executor, id: manager.id })),
    ).rejects.toThrow(/project_members_project_user_unique|23505/);
    await insertMember(
      handle.db,
      defineProjectMember({ ...executor, id: manager.id, projectId: otherProjectId }),
    );
    const rows = await sql<{ project_id: string }>`
      SELECT project_id::text AS project_id FROM project_members WHERE user_id = ${userId}::uuid ORDER BY project_id
    `.execute(handle.db);
    expect(rows.rows.map((row) => row.project_id)).toEqual([projectId, otherProjectId]);
  });
});

describe('INV-18 роли две — member и lead', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-18 роли две: member — исполнитель, lead — руководитель, оба ведут задачи', () => {
    expect(PROJECT_ROLES).toEqual([MEMBER_ROLE, LEAD_ROLE]);
    const member = defineProjectMember(executor);
    const lead = defineProjectMember(manager);
    expect(member.role).toBe(MEMBER_ROLE);
    expect(lead.role).toBe(LEAD_ROLE);
    expect(leadsTasks(member.role)).toBe(true);
    expect(leadsTasks(lead.role)).toBe(true);
  });

  it('INV-18 роли «только просмотр» нет: домен отвергает любую третью роль', () => {
    for (const role of ['viewer', 'readonly', 'guest', 'admin', 'member ', 'LEAD', '']) {
      expect(() => defineProjectMember({ ...executor, role })).toThrow(DomainError);
      expect(() => defineProjectMember({ ...executor, role })).toThrow(
        expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_ROLE }),
      );
    }
    expect(() => defineProjectMember({ ...executor, id: ' ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_MEMBER_ID_BLANK }),
    );
    expect(() => defineProjectMember({ ...executor, projectId: '' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_MEMBER_PROJECT_BLANK }),
    );
    expect(() => defineProjectMember({ ...executor, userId: '  ' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.PROJECT_MEMBER_USER_BLANK }),
    );
  });

  it('INV-18 constraint роли: в таблице только member и lead', async () => {
    const handle = await openMembers();
    opened.push(handle);
    await seed(handle.db);
    const spectatorId = '00000000-0000-4000-8000-000000000003';
    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES (${spectatorId}::uuid, 1003, 'Вера', false)
    `.execute(handle.db);
    await insertMember(handle.db, defineProjectMember(executor));
    await insertMember(handle.db, defineProjectMember(manager));
    const viewer = sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES (
        '00000000-0000-4000-8000-0000000000a3'::uuid,
        ${projectId}::uuid,
        ${spectatorId}::uuid,
        'viewer'
      )
    `.execute(handle.db);
    await expect(viewer).rejects.toThrow(/project_members_role|23514/);
    const count = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM project_members`.execute(handle.db);
    expect(Number(count.rows[0]?.n)).toBe(2);
  });
});
