import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GITHUB_LOGIN_ACTOR_ROLE,
  GITHUB_LOGIN_SUBJECT,
  setOwnGithubLogin,
  showGithubAct,
  type GithubLoginStore,
} from '../src/domain/projects/github-login.ts';
import type { User } from '../src/domain/projects/user.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES, type EventJournal, type EventRow } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createGithubLogin } from '../src/infrastructure/github-login.ts';
import { readEventsMigration, readProjectMembersMigration, readProjectsMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { isMemberAddedReply, addedReply } from '../src/telegram/members.ts';
import {
  deliverGithubLoginPrompt,
  GITHUB_LOGIN_ASK,
  GITHUB_LOGIN_HEADING,
  GITHUB_LOGIN_SELF,
  GITHUB_LOGIN_SKIP_DATA,
  GITHUB_LOGIN_SKIPPED,
  GITHUB_LOGIN_TAKEN,
  githubLoginSavedReply,
  githubLoginSkipKeyboard,
  parseGithubLoginMessage,
  replyToGithubLogin,
} from '../src/telegram/github-login.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };

const alphaMember = '00000000-0000-4000-8000-0000000000a1';
const betaMember = '00000000-0000-4000-8000-0000000000a2';

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  rootId: string;
  borisId: string;
  alphaId: string;
  betaId: string;
}

function memoryJournal(): { journal: EventJournal; rows: EventRow[] } {
  const rows: EventRow[] = [];
  return {
    rows,
    journal: {
      async append(row) {
        const found = rows.find((item) => item.idempotencyKey === row.idempotencyKey);
        if (found !== undefined) return { inserted: false, row: found };
        rows.push(row);
        return { inserted: true, row };
      },
      refuse: () => undefined,
    },
  };
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
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

async function seed(): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, silentLogger, clock);
  const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const creation = createProjectCreation(handle.db, silentLogger, clock);
  const alpha = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  const beta = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Бета',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-beta',
  });
  return {
    db: handle.db,
    close: handle.close,
    rootId: root.user.id,
    borisId: boris.user.id,
    alphaId: alpha.project.id,
    betaId: beta.project.id,
  };
}

async function loginOf(db: Kysely<Database>, userId: string): Promise<string | null> {
  const result = await sql<{ github_login: string | null }>`
    SELECT github_login FROM users WHERE id = ${userId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('пользователь не найден');
  return row.github_login;
}

function payloadOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}

async function loginEvents(db: Kysely<Database>): Promise<
  { idempotencyKey: string; payload: unknown; actorId: string; actorRole: string; subjectEntity: string; subjectId: string }[]
> {
  const result = await sql<{
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
    subject_id: string;
  }>`
    SELECT idempotency_key, payload, actor_id, actor_role, subject_entity, subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.USER_GITHUB_LOGIN_SET}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    payload: payloadOf(row.payload),
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subjectEntity: row.subject_entity,
    subjectId: row.subject_id,
  }));
}

describe('INV-19 свой логин GitHub человек меняет сам', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 в личке человек меняет свой логин, чужой логин корень не записывает', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createGithubLogin(fixture.db, silentLogger, clock);
    const saved = await replyToGithubLogin('private', borisAccount, 'boris-ada', '  ada  ', actions);
    expect(saved).toBe(githubLoginSavedReply('ada'));
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('ada');
    expect(borisAccount.first_name).not.toBe('ada');
    const events = await loginEvents(fixture.db);
    expect(events).toEqual([
      {
        idempotencyKey: 'boris-ada',
        payload: { user_id: fixture.borisId, github_login: 'ada' },
        actorId: fixture.borisId,
        actorRole: GITHUB_LOGIN_ACTOR_ROLE,
        subjectEntity: GITHUB_LOGIN_SUBJECT,
        subjectId: fixture.borisId,
      },
    ]);

    const changed = await replyToGithubLogin('private', borisAccount, 'boris-grace', 'grace', actions);
    expect(changed).toBe(githubLoginSavedReply('grace'));
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('grace');
    expect(await loginOf(fixture.db, fixture.rootId)).toBeNull();

    const outside = await replyToGithubLogin('supergroup', borisAccount, 'boris-group', 'octo', actions);
    expect(outside).toBeNull();
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('grace');

    const rootSaved = await replyToGithubLogin('private', rootAccount, 'root-anya', 'anya', actions);
    expect(rootSaved).toBe(githubLoginSavedReply('anya'));
    expect(await loginOf(fixture.db, fixture.rootId)).toBe('anya');
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('grace');

    const root: User = {
      id: fixture.rootId,
      telegramUserId: String(rootAccount.id),
      githubLogin: 'anya',
      name: 'Аня',
      isRoot: true,
    };
    const stored = memoryJournal();
    const writes: { userId: string; login: string | null }[] = [];
    const store: GithubLoginStore = {
      async ownerId() {
        return null;
      },
      async save(userId, login) {
        writes.push({ userId, login });
      },
    };
    await expect(
      setOwnGithubLogin(store, stored.journal, clock, {
        actor: root,
        userId: fixture.borisId,
        chat: 'private',
        login: 'stolen',
        skip: false,
        idempotencyKey: 'root-steals',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.GITHUB_LOGIN_ACTOR });
    expect(writes).toEqual([]);
    expect(stored.rows).toEqual([]);
    await expect(
      setOwnGithubLogin(store, stored.journal, clock, {
        actor: root,
        userId: fixture.rootId,
        chat: 'group',
        login: 'other',
        skip: false,
        idempotencyKey: 'root-group',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.GITHUB_LOGIN_CHAT });
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('grace');

    const taken = await replyToGithubLogin('private', borisAccount, 'boris-anya', 'Anya', actions);
    expect(taken).toBe(GITHUB_LOGIN_TAKEN);
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('grace');
    expect(await replyToGithubLogin('private', { id: 1002, is_bot: false }, 'no-such', 'x', {
      async find() {
        return null;
      },
      async set() {
        throw new DomainError(DOMAIN_ERROR.GITHUB_LOGIN_ACTOR, 'логин GitHub меняет сам человек');
      },
    })).toBe(GITHUB_LOGIN_SELF);
  });
});

describe('INV-20 шаг логина можно пропустить, логин один на пользователя', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-20 пропуск не требует логина и не заводит его на каждый проект', async () => {
    expect(parseGithubLoginMessage(`${GITHUB_LOGIN_HEADING}\nada`)).toEqual({ login: 'ada' });
    expect(parseGithubLoginMessage(`${GITHUB_LOGIN_HEADING}\n`)).toEqual({ login: '' });
    expect(parseGithubLoginMessage('привет')).toBeNull();
    expect(isMemberAddedReply(addedReply('Борис'))).toBe(true);
    expect(isMemberAddedReply('Уже в проекте.')).toBe(false);
    expect(GITHUB_LOGIN_ASK).toContain('Шаг можно пропустить.');
    expect(GITHUB_LOGIN_ASK).toContain('не на каждый проект');
    expect(GITHUB_LOGIN_SKIP_DATA.length).toBeLessThanOrEqual(64);
    const skipButton = githubLoginSkipKeyboard().inline_keyboard[0]?.[0];
    expect(skipButton !== undefined && 'callback_data' in skipButton ? skipButton.callback_data : undefined).toBe(GITHUB_LOGIN_SKIP_DATA);

    const asked: string[] = [];
    await deliverGithubLoginPrompt({ githubLogin: null }, async (text) => {
      asked.push(text);
    });
    expect(asked).toEqual([GITHUB_LOGIN_ASK]);
    const again: string[] = [];
    await deliverGithubLoginPrompt({ githubLogin: 'ada' }, async (text) => {
      again.push(text);
    });
    await deliverGithubLoginPrompt(null, async (text) => {
      again.push(text);
    });
    expect(again).toEqual([]);

    const fixture = await seed();
    opened.push(fixture);
    const actions = createGithubLogin(fixture.db, silentLogger, clock);
    const skipped = await replyToGithubLogin('private', borisAccount, 'skip-boris', '', actions);
    expect(skipped).toBe(GITHUB_LOGIN_SKIPPED);
    expect(await loginOf(fixture.db, fixture.borisId)).toBeNull();
    expect(await loginEvents(fixture.db)).toEqual([
      expect.objectContaining({
        idempotencyKey: 'skip-boris',
        payload: { user_id: fixture.borisId, github_login: null },
        actorId: fixture.borisId,
      }),
    ]);

    await replyToGithubLogin('private', borisAccount, 'boris-ada', 'ada', actions);
    const keep = await replyToGithubLogin('private', borisAccount, 'skip-again', '', actions);
    expect(keep).toBe(githubLoginSavedReply('ada'));
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('ada');
    const afterSkip = await loginEvents(fixture.db);
    expect(afterSkip.map((event) => event.idempotencyKey).sort()).toEqual(['boris-ada', 'skip-boris']);

    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES
        (${alphaMember}::uuid, ${fixture.alphaId}::uuid, ${fixture.borisId}::uuid, 'member'),
        (${betaMember}::uuid, ${fixture.betaId}::uuid, ${fixture.borisId}::uuid, 'member')
    `.execute(fixture.db);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'project_members' AND column_name = 'github_login'
    `.execute(fixture.db);
    expect(columns.rows).toEqual([]);
    const rows = await sql<{ project_id: string; github_login: string | null }>`
      SELECT project_members.project_id::text AS project_id, users.github_login
      FROM project_members
      INNER JOIN users ON users.id = project_members.user_id
      WHERE project_members.user_id = ${fixture.borisId}::uuid
      ORDER BY project_members.project_id::text
    `.execute(fixture.db);
    const byProject = [...rows.rows].sort((left, right) => left.project_id.localeCompare(right.project_id));
    const expected = [
      { project_id: fixture.alphaId, github_login: 'ada' },
      { project_id: fixture.betaId, github_login: 'ada' },
    ].sort((left, right) => left.project_id.localeCompare(right.project_id));
    expect(byProject).toEqual(expected);
    const stored = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM users WHERE github_login = 'ada'
    `.execute(fixture.db);
    expect(Number(stored.rows[0]?.n)).toBe(1);
  });
});

describe('INV-22 повтор записи логина не применяется второй раз', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не меняет логин и не пишет второе событие', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createGithubLogin(fixture.db, silentLogger, clock);
    const first = await replyToGithubLogin('private', borisAccount, 'same-key', 'ada', actions);
    const second = await replyToGithubLogin('private', borisAccount, 'same-key', 'grace', actions);
    expect(first).toBe(githubLoginSavedReply('ada'));
    expect(second).toBeNull();
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('ada');
    expect(await loginEvents(fixture.db)).toHaveLength(1);

    await expect(
      actions.set({
        telegramUserId: String(borisAccount.id),
        chat: 'private',
        login: 'octo',
        skip: false,
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.GITHUB_LOGIN_IDEMPOTENCY_KEY });
    expect(await loginOf(fixture.db, fixture.borisId)).toBe('ada');
    expect(await loginEvents(fixture.db)).toHaveLength(1);
  });
});

describe('INV-14 логин сопоставляется в момент показа', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-14 действие остаётся под именем логина и к человеку приклеивается только текущим логином', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createGithubLogin(fixture.db, silentLogger, clock);
    await replyToGithubLogin('private', borisAccount, 'show-ada', 'ada', actions);
    const people = [{ id: fixture.borisId, githubLogin: 'ada', name: 'Борис' }];
    expect(showGithubAct(people, 'ADA')).toEqual({ login: 'ADA', userId: fixture.borisId });
    expect(showGithubAct(people, 'ADA').login).not.toBe('Борис');
    expect(showGithubAct(people, 'octocat')).toEqual({ login: 'octocat', userId: null });

    await replyToGithubLogin('private', borisAccount, 'show-grace', 'grace', actions);
    const current = [{ id: fixture.borisId, githubLogin: await loginOf(fixture.db, fixture.borisId) }];
    expect(showGithubAct(current, 'ada')).toEqual({ login: 'ada', userId: null });
    expect(showGithubAct(current, 'grace')).toEqual({ login: 'grace', userId: fixture.borisId });
    expect(showGithubAct(current, 'grace').userId).not.toBe(fixture.rootId);
  });
});
