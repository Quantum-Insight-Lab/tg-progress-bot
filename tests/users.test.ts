import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { createRoot, isFirstLead, type NewUser, type User, type UserStore } from '../src/domain/projects/user.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';
import { registerRoot } from '../src/infrastructure/users.ts';

const rootInput: NewUser = {
  id: '00000000-0000-4000-8000-000000000001',
  telegramUserId: '1001',
  name: 'Аня',
};

const secondInput: NewUser = {
  id: '00000000-0000-4000-8000-000000000002',
  telegramUserId: '1002',
  name: 'Борис',
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return path.endsWith('.ts') || path.endsWith('.sql') ? [path] : [];
  });
}

function memoryStore(existing: number): UserStore & { inserted: User[] } {
  const inserted: User[] = [];
  return {
    inserted,
    async countForUpdate() {
      return existing;
    },
    async insert(user) {
      inserted.push(user);
    },
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

async function countUsers(db: Kysely<Database>, onlyRoot = false): Promise<number> {
  const result = onlyRoot
    ? await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users WHERE is_root`.execute(db)
    : await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('count без строки');
  return Number(row.n);
}

describe('INV-17 корень один — первый /start', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('INV-17 пустая таблица: первый пользователь — единственный корень и первый lead', async () => {
    const store = memoryStore(0);
    const user = await createRoot(store, rootInput);
    expect(user.isRoot).toBe(true);
    expect(isFirstLead(user)).toBe(true);
    expect(store.inserted).toEqual([user]);

    const handle = await openUsers();
    opened.push(handle);
    const registered = await registerRoot(handle.db, rootInput);
    expect(registered).toEqual(user);
    expect(isFirstLead(registered)).toBe(true);
    expect(await countUsers(handle.db)).toBe(1);
    expect(await countUsers(handle.db, true)).toBe(1);
    const row = await sql<{ telegram_user_id: string; name: string; is_root: boolean }>`
      SELECT CAST(telegram_user_id AS text) AS telegram_user_id, name, is_root FROM users
    `.execute(handle.db);
    expect(row.rows[0]).toEqual({ telegram_user_id: rootInput.telegramUserId, name: rootInput.name, is_root: true });
  });

  it('INV-17 второй вызов корнем не становится и строку не пишет', async () => {
    const store = memoryStore(1);
    await expect(createRoot(store, secondInput)).rejects.toMatchObject({
      name: 'DomainError',
      code: DOMAIN_ERROR.USERS_ALREADY_EXIST,
    });
    expect(store.inserted).toEqual([]);

    const handle = await openUsers();
    opened.push(handle);
    await registerRoot(handle.db, rootInput);
    await expect(registerRoot(handle.db, secondInput)).rejects.toBeInstanceOf(DomainError);
    expect(await countUsers(handle.db)).toBe(1);
    expect(await countUsers(handle.db, true)).toBe(1);
  });

  it('INV-17 второй is_root нарушает уникальный constraint и откатывается', async () => {
    const handle = await openUsers();
    opened.push(handle);
    await registerRoot(handle.db, rootInput);
    const duplicate = sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES ('00000000-0000-4000-8000-000000000002', 1002, 'Борис', true)
    `.execute(handle.db);
    await expect(duplicate).rejects.toThrow(/duplicate key|23505|users_one_root/);
    expect(await countUsers(handle.db)).toBe(1);
    expect(await countUsers(handle.db, true)).toBe(1);
  });

  it('INV-17 пользователь без корня нарушает constraint ровно одного is_root', async () => {
    const handle = await openUsers();
    opened.push(handle);
    const alone = sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES ('00000000-0000-4000-8000-000000000003', 1003, 'Вера', false)
    `.execute(handle.db);
    await expect(alone).rejects.toThrow(/ровно у одного|23514/);
    expect(await countUsers(handle.db)).toBe(0);

    await registerRoot(handle.db, rootInput);
    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES ('00000000-0000-4000-8000-000000000003', 1003, 'Вера', false)
    `.execute(handle.db);
    expect(await countUsers(handle.db)).toBe(2);
    expect(await countUsers(handle.db, true)).toBe(1);

    const clear = sql`UPDATE users SET is_root = false`.execute(handle.db);
    await expect(clear).rejects.toThrow(/ровно у одного|23514/);
    expect(await countUsers(handle.db, true)).toBe(1);
  });

  it('INV-17 telegram_user_id уникален', async () => {
    const handle = await openUsers();
    opened.push(handle);
    await registerRoot(handle.db, rootInput);
    const sameTelegram = sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES ('00000000-0000-4000-8000-000000000004', 1001, 'Другой', false)
    `.execute(handle.db);
    await expect(sameTelegram).rejects.toThrow(/duplicate key|23505|users_telegram_user_id_unique/);
    expect(await countUsers(handle.db)).toBe(1);
  });

  it('INV-17 создание корня — одна транзакция: сбой вставки не оставляет строку', async () => {
    const handle = await openUsers();
    opened.push(handle);
    await expect(
      registerRoot(handle.db, { ...rootInput, id: 'не-uuid' }),
    ).rejects.toThrow();
    expect(await countUsers(handle.db)).toBe(0);
  });

  it('INV-17 решение о корне принимает домен, запись users — только регистрация корня', () => {
    const adapter = readFileSync('src/infrastructure/users.ts', 'utf8');
    expect(adapter).toContain('createRoot(');
    expect(adapter).toContain('transaction()');
    expect(adapter).not.toContain('isRoot: true');
    const sources = [...filesUnder('src'), ...filesUnder('migrations')];
    const insert = sources.filter((path) => readFileSync(path, 'utf8').includes("insertInto('users')"));
    expect(insert.map((path) => path.replaceAll('\\', '/'))).toEqual(['src/infrastructure/users.ts']);
  });
});
