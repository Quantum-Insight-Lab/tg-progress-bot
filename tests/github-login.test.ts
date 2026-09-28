import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  matchesCurrentGithubLogin,
  withCurrentGithubLogin,
} from '../src/domain/projects/github-login.ts';
import { defineProjectMember, LEAD_ROLE, leadsTasks, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import type { User } from '../src/domain/projects/user.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { recordGithubLogin } from '../src/infrastructure/github-login.ts';
import {
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { registerRoot } from '../src/infrastructure/users.ts';

const anyaId = '00000000-0000-4000-8000-000000000001';
const borisId = '00000000-0000-4000-8000-000000000002';

const anya: User = {
  id: anyaId,
  telegramUserId: '1001',
  githubLogin: null,
  name: 'Аня',
  isRoot: true,
};

function boris(): User {
  return {
    id: borisId,
    telegramUserId: '1002',
    githubLogin: null,
    name: 'Борис',
    isRoot: false,
  };
}

async function openUsers(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
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
  await registerRoot(db, {
    id: anyaId,
    telegramUserId: anya.telegramUserId,
    name: anya.name,
  });
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${borisId}::uuid, 1002, 'Борис', false)
  `.execute(db);
}

async function loginOf(db: Kysely<Database>, userId: string): Promise<string | null> {
  const result = await sql<{ github_login: string | null }>`
    SELECT github_login FROM users WHERE id = ${userId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('пользователь не найден');
  return row.github_login;
}

describe('INV-14 логин GitHub — текущее поле users', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-14 к пользователю можно записать логин; пустой — сопоставления нет и уникальность не нарушает', async () => {
    expect(withCurrentGithubLogin(anya, '  ').githubLogin).toBeNull();
    expect(withCurrentGithubLogin(anya, null).githubLogin).toBeNull();
    expect(matchesCurrentGithubLogin(null, 'ada')).toBe(false);
    expect(matchesCurrentGithubLogin('  ', 'ada')).toBe(false);

    const handle = await openUsers();
    opened.push(handle);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'github_login'
    `.execute(handle.db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['github_login']);

    await seed(handle.db);
    expect(await loginOf(handle.db, anyaId)).toBeNull();
    expect(await loginOf(handle.db, borisId)).toBeNull();

    const cleared = await recordGithubLogin(handle.db, anyaId, '   ');
    const alsoCleared = await recordGithubLogin(handle.db, borisId, '');
    expect(cleared.githubLogin).toBeNull();
    expect(alsoCleared.githubLogin).toBeNull();
    expect(await loginOf(handle.db, anyaId)).toBeNull();
    expect(await loginOf(handle.db, borisId)).toBeNull();

    const blank = sql`
      UPDATE users SET github_login = '   ' WHERE id = ${anyaId}::uuid
    `.execute(handle.db);
    await expect(blank).rejects.toThrow(/users_github_login_not_blank|23514/);
    expect(await loginOf(handle.db, anyaId)).toBeNull();

    const recorded = await recordGithubLogin(handle.db, anyaId, '  ada  ');
    expect(recorded.githubLogin).toBe('ada');
    expect(await loginOf(handle.db, anyaId)).toBe('ada');
    expect(matchesCurrentGithubLogin(recorded.githubLogin, 'ADA')).toBe(true);

    await expect(recordGithubLogin(handle.db, '00000000-0000-4000-8000-000000000099', 'grace')).rejects.toMatchObject({
      name: 'DomainError',
      code: DOMAIN_ERROR.USER_NOT_FOUND,
    });
  });

  it('INV-14 один логин GitHub принадлежит одному пользователю бота', async () => {
    const handle = await openUsers();
    opened.push(handle);
    await seed(handle.db);
    await recordGithubLogin(handle.db, anyaId, 'Ada');
    await expect(recordGithubLogin(handle.db, borisId, 'ada')).rejects.toBeInstanceOf(DomainError);
    await expect(recordGithubLogin(handle.db, borisId, 'ADA')).rejects.toMatchObject({
      code: DOMAIN_ERROR.GITHUB_LOGIN_TAKEN,
    });
    expect(await loginOf(handle.db, borisId)).toBeNull();

    const again = await recordGithubLogin(handle.db, anyaId, 'Ada');
    expect(again.githubLogin).toBe('Ada');

    const duplicate = sql`
      UPDATE users SET github_login = 'ada' WHERE id = ${borisId}::uuid
    `.execute(handle.db);
    await expect(duplicate).rejects.toThrow(/users_github_login_unique|23505/);
    expect(await loginOf(handle.db, borisId)).toBeNull();
  });

  it('INV-14 в поле хранится текущий логин: старый после смены ника новые факты не сопоставляет', async () => {
    const handle = await openUsers();
    opened.push(handle);
    await seed(handle.db);
    const first = await recordGithubLogin(handle.db, anyaId, 'ada');
    expect(matchesCurrentGithubLogin(first.githubLogin, 'ada')).toBe(true);
    expect(matchesCurrentGithubLogin(first.githubLogin, 'grace')).toBe(false);

    const next = await recordGithubLogin(handle.db, anyaId, 'grace');
    expect(next.githubLogin).toBe('grace');
    expect(await loginOf(handle.db, anyaId)).toBe('grace');
    expect(matchesCurrentGithubLogin(next.githubLogin, 'grace')).toBe(true);
    expect(matchesCurrentGithubLogin(next.githubLogin, 'ada')).toBe(false);

    const freed = await recordGithubLogin(handle.db, borisId, 'ada');
    expect(freed.githubLogin).toBe('ada');
    expect(matchesCurrentGithubLogin(freed.githubLogin, 'ada')).toBe(true);
    expect(await loginOf(handle.db, anyaId)).toBe('grace');
  });

  it('INV-14 без логина участник ведёт задачи как обычно', async () => {
    expect(anya.githubLogin).toBeNull();
    expect(leadsTasks(MEMBER_ROLE)).toBe(true);
    expect(leadsTasks(LEAD_ROLE)).toBe(true);
    const member = defineProjectMember({
      id: '00000000-0000-4000-8000-0000000000a1',
      projectId: '00000000-0000-4000-8000-000000000010',
      userId: borisId,
      role: MEMBER_ROLE,
    });
    expect(leadsTasks(member.role)).toBe(true);
    expect(matchesCurrentGithubLogin(boris().githubLogin, 'ada')).toBe(false);

    const pglite = new PGlite();
    await pglite.exec(readEventsMigration());
    await pglite.exec(readUsersMigration());
    await pglite.exec(readProjectsMigration());
    await pglite.exec(readProjectMembersMigration());
    const db = new Kysely<Database>({
      dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
    });
    opened.push({
      close: async () => {
        await db.destroy();
      },
    });
    await seed(db);
    expect(await loginOf(db, borisId)).toBeNull();
    await sql`
      INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
      VALUES (
        ${member.projectId}::uuid,
        'Альфа',
        '',
        'Europe/Moscow',
        NULL,
        '2026-09-28T07:33:00.000Z'::timestamptz
      )
    `.execute(db);
    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES (${member.id}::uuid, ${member.projectId}::uuid, ${member.userId}::uuid, ${member.role})
    `.execute(db);
    const rows = await sql<{ user_id: string; github_login: string | null; role: string }>`
      SELECT project_members.user_id::text AS user_id, users.github_login, project_members.role
      FROM project_members
      INNER JOIN users ON users.id = project_members.user_id
      WHERE project_members.id = ${member.id}::uuid
    `.execute(db);
    expect(rows.rows).toEqual([{ user_id: borisId, github_login: null, role: MEMBER_ROLE }]);
    expect(leadsTasks(MEMBER_ROLE)).toBe(true);
  });
});
