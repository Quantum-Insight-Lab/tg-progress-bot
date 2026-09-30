import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallationRepositorySource } from '../src/domain/github/repository.ts';
import {
  PROJECT_REPOSITORY_CHANGE_ACTOR_ROLE,
  projectGithubPicture,
  projectProgressLine,
} from '../src/domain/projects/connect-repository.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { createProjectRepository } from '../src/infrastructure/connect-repository.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createInstallationRepositories } from '../src/infrastructure/installation-repositories.ts';
import {
  readEventsMigration,
  readProjectMembersMigration,
  readProjectRepositoryMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { registerRoot } from '../src/infrastructure/users.ts';
import {
  changeRepositoryData,
  openProjectRepositoryStep,
  parseChangeRepositoryData,
  PROJECT_REPOSITORY_ALREADY,
  PROJECT_REPOSITORY_CHANGE_ACTOR_REPLY,
  PROJECT_REPOSITORY_NOT_CONNECTED,
  PROJECT_REPOSITORY_ROOT_CHANGES,
  PROJECT_REPOSITORY_SKIP_LABEL,
  projectRepositoryChangedReply,
  projectRepositoryChangeKeyboard,
  projectRepositoryCurrent,
  replyToChangeRepository,
  replyToConnectRepository,
} from '../src/telegram/connect-repository.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const leadAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const memberAccount = { id: 1003, is_bot: false, first_name: 'Вера' };

const rootId = '00000000-0000-4000-8000-000000000001';
const leadUserId = '00000000-0000-4000-8000-000000000002';
const memberUserId = '00000000-0000-4000-8000-000000000003';
const alphaId = '00000000-0000-4000-8000-000000000010';
const betaId = '00000000-0000-4000-8000-000000000011';
const gammaId = '00000000-0000-4000-8000-000000000012';

const repoId = '42';
const otherRepoId = '43';

const source: InstallationRepositorySource = {
  async list() {
    return [
      { id: repoId, owner: 'lab', name: 'bot' },
      { id: otherRepoId, owner: 'lab', name: 'other' },
    ];
  },
};

interface Handle {
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function openDb(): Promise<Handle> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
  await pglite.exec(readProjectRepositoryMigration());
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
  await registerRoot(db, { id: rootId, telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${leadUserId}::uuid, ${leadAccount.id}, 'Борис', false),
           (${memberUserId}::uuid, ${memberAccount.id}, 'Вера', false)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at)
    VALUES (${alphaId}::uuid, 'Альфа', '', 'Europe/Moscow', ${clock.now().toISOString()}::timestamptz),
           (${betaId}::uuid, 'Бета', '', 'Europe/Moscow', ${clock.now().toISOString()}::timestamptz),
           (${gammaId}::uuid, 'Гамма', '', 'Europe/Moscow', ${clock.now().toISOString()}::timestamptz)
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (${'00000000-0000-4000-8000-0000000000a2'}::uuid, ${betaId}::uuid, ${leadUserId}::uuid, 'lead'),
           (${'00000000-0000-4000-8000-0000000000a3'}::uuid, ${alphaId}::uuid, ${memberUserId}::uuid, 'member')
  `.execute(db);
}

function actionsOf(db: Kysely<Database>) {
  return {
    connection: createProjectRepository(db, silentLogger, clock),
    installation: createInstallationRepositories(db, source),
  };
}

async function repositoryIdOf(db: Kysely<Database>, projectId: string): Promise<string | null> {
  const result = await sql<{ repository_id: string | null }>`
    SELECT repository_id FROM projects WHERE id = ${projectId}::uuid
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('проект не найден');
  return row.repository_id;
}

async function changedEvents(db: Kysely<Database>): Promise<
  { idempotencyKey: string; payload: unknown; actorId: string; actorRole: string; subjectId: string }[]
> {
  const result = await sql<{
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_id: string;
  }>`
    SELECT idempotency_key, payload, actor_id, actor_role, subject_id
    FROM events
    WHERE event_type = ${EVENT_TYPES.PROJECT_REPOSITORY_CHANGED}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subjectId: row.subject_id,
  }));
}

function callbackData(button: object | undefined): string | undefined {
  if (button === undefined || !('callback_data' in button)) return undefined;
  const data = button.callback_data;
  return typeof data === 'string' ? data : undefined;
}

async function memberRows(db: Kysely<Database>): Promise<{ projectId: string; userId: string; role: string }[]> {
  const result = await sql<{ project_id: string; user_id: string; role: string }>`
    SELECT project_id::text AS project_id, user_id::text AS user_id, role
    FROM project_members
    ORDER BY id
  `.execute(db);
  return result.rows.map((row) => ({ projectId: row.project_id, userId: row.user_id, role: row.role }));
}

async function projectIdentity(db: Kysely<Database>): Promise<{ id: string; name: string; description: string; timezone: string }[]> {
  const result = await sql<{ id: string; name: string; description: string; timezone: string }>`
    SELECT id::text AS id, name, description, timezone
    FROM projects
    ORDER BY id
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    timezone: row.timezone,
  }));
}

async function connectShared(db: Kysely<Database>): Promise<void> {
  const { connection, installation } = actionsOf(db);
  await openProjectRepositoryStep('private', rootAccount, 'list-alpha', 'Альфа', connection, installation);
  await replyToConnectRepository('private', rootAccount, 'connect-alpha', alphaId, repoId, connection);
  await replyToConnectRepository('private', leadAccount, 'connect-beta', betaId, repoId, connection);
}

describe('INV-19 репозиторий меняет только корень в личке', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 корень в личке сменяет репозиторий, руководитель и исполнитель — нет', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection, installation } = actionsOf(handle.db);
    await connectShared(handle.db);

    const outside = await replyToChangeRepository('group', rootAccount, 'outside', alphaId, otherRepoId, connection);
    expect(outside).toBeNull();
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);

    const absent = await replyToChangeRepository('private', rootAccount, 'gamma-change', gammaId, otherRepoId, connection);
    expect(absent).toBe(PROJECT_REPOSITORY_NOT_CONNECTED);
    expect(await repositoryIdOf(handle.db, gammaId)).toBeNull();

    const step = await openProjectRepositoryStep('private', rootAccount, 'open-change', 'Альфа', connection, installation);
    expect(step?.text).toContain(PROJECT_REPOSITORY_ROOT_CHANGES);
    expect(step?.text).toContain(projectRepositoryCurrent('lab', 'bot'));
    expect(step?.markup?.inline_keyboard.flat().map((button) => button.text)).toEqual(['lab/other']);
    expect(step?.markup?.inline_keyboard.flat().map((button) => button.text)).not.toContain(PROJECT_REPOSITORY_SKIP_LABEL);
    const choice = callbackData(step?.markup?.inline_keyboard[0]?.[0]);
    if (choice === undefined) throw new Error('кнопка смены');
    expect(parseChangeRepositoryData(choice)).toEqual({ projectId: alphaId, repositoryId: otherRepoId });
    expect(choice).toBe(changeRepositoryData(alphaId, otherRepoId));

    const leadScreen = await openProjectRepositoryStep('private', leadAccount, 'lead-screen', 'Бета', connection, installation);
    expect(leadScreen?.text).toContain(projectRepositoryCurrent('lab', 'bot'));
    expect(leadScreen?.text).not.toContain(PROJECT_REPOSITORY_ROOT_CHANGES);
    expect(leadScreen?.markup).toBeUndefined();

    const lead = await replyToChangeRepository('private', leadAccount, 'lead-change', betaId, otherRepoId, connection);
    expect(lead).toBe(PROJECT_REPOSITORY_CHANGE_ACTOR_REPLY);
    expect(await repositoryIdOf(handle.db, betaId)).toBe(repoId);

    const member = await replyToChangeRepository('private', memberAccount, 'member-change', alphaId, otherRepoId, connection);
    expect(member).toBe(PROJECT_REPOSITORY_CHANGE_ACTOR_REPLY);
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);

    const changed = await replyToChangeRepository('private', rootAccount, 'change-alpha', alphaId, otherRepoId, connection);
    expect(changed).toBe(projectRepositoryChangedReply('lab', 'other'));
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(otherRepoId);
    expect(await changedEvents(handle.db)).toEqual([
      {
        idempotencyKey: 'change-alpha',
        payload: { project_id: alphaId, repository_id: otherRepoId, previous_repository_id: repoId },
        actorId: rootId,
        actorRole: PROJECT_REPOSITORY_CHANGE_ACTOR_ROLE,
        subjectId: alphaId,
      },
    ]);

    const stillConnected = await replyToConnectRepository('private', rootAccount, 'connect-again', alphaId, repoId, connection);
    expect(stillConnected).toBe(PROJECT_REPOSITORY_ALREADY);
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(otherRepoId);

    await expect(
      connection.change({
        telegramUserId: '9999',
        projectId: alphaId,
        repositoryId: repoId,
        chat: 'private',
        idempotencyKey: 'stranger',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_REPOSITORY_ACCESS });
    await expect(
      connection.change({
        telegramUserId: String(rootAccount.id),
        projectId: alphaId,
        repositoryId: repoId,
        chat: 'group',
        idempotencyKey: 'group-domain',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_REPOSITORY_CHAT });
  });
});

describe('INV-03 смена репозитория меняет картину и линейку, задачи и люди остаются', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-03 после смены картина и линейка читаются с нового репозитория, люди и проект на месте', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection } = actionsOf(handle.db);
    await connectShared(handle.db);
    const peopleBefore = await memberRows(handle.db);
    const projectsBefore = await projectIdentity(handle.db);

    expect(projectGithubPicture(await repositoryIdOf(handle.db, alphaId))).toBe(repoId);
    expect(projectProgressLine(await repositoryIdOf(handle.db, alphaId))).toBe(repoId);
    expect(projectGithubPicture(await repositoryIdOf(handle.db, betaId))).toBe(projectGithubPicture(await repositoryIdOf(handle.db, alphaId)));
    expect(projectProgressLine(await repositoryIdOf(handle.db, betaId))).toBe(projectProgressLine(await repositoryIdOf(handle.db, alphaId)));

    const changed = await replyToChangeRepository('private', rootAccount, 'alpha-to-43', alphaId, otherRepoId, connection);
    expect(changed).toBe(projectRepositoryChangedReply('lab', 'other'));

    const alpha = await repositoryIdOf(handle.db, alphaId);
    const beta = await repositoryIdOf(handle.db, betaId);
    expect(projectGithubPicture(alpha)).toBe(otherRepoId);
    expect(projectProgressLine(alpha)).toBe(otherRepoId);
    expect(projectGithubPicture(alpha)).toBe(projectProgressLine(alpha));
    expect(projectGithubPicture(beta)).toBe(repoId);
    expect(projectProgressLine(beta)).toBe(repoId);
    expect(projectGithubPicture(alpha)).not.toBe(projectGithubPicture(beta));

    await replyToConnectRepository('private', rootAccount, 'gamma-43', gammaId, otherRepoId, connection);
    expect(projectGithubPicture(await repositoryIdOf(handle.db, gammaId))).toBe(projectGithubPicture(alpha));
    expect(projectProgressLine(await repositoryIdOf(handle.db, gammaId))).toBe(projectProgressLine(alpha));

    const mirror = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM repositories WHERE id = ${otherRepoId}`.execute(
      handle.db,
    );
    expect(Number(mirror.rows[0]?.n)).toBe(1);
    const linked = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM projects WHERE repository_id = ${otherRepoId}
    `.execute(handle.db);
    expect(Number(linked.rows[0]?.n)).toBe(2);

    expect(await memberRows(handle.db)).toEqual(peopleBefore);
    expect(await projectIdentity(handle.db)).toEqual(projectsBefore);
    const removed = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events WHERE event_type = ${'project.member_removed'}
    `.execute(handle.db);
    expect(Number(removed.rows[0]?.n)).toBe(0);

    const keyboard = projectRepositoryChangeKeyboard(alphaId, [{ id: otherRepoId, owner: 'lab', name: 'other' }], repoId);
    expect(callbackData(keyboard.inline_keyboard[0]?.[0])).toBe(changeRepositoryData(alphaId, otherRepoId));
  });
});

describe('INV-22 повтор смены репозитория не применяется второй раз', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не пишет второе событие и не меняет ссылку', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection } = actionsOf(handle.db);
    await connectShared(handle.db);

    const first = await replyToChangeRepository('private', rootAccount, 'same-key', alphaId, otherRepoId, connection);
    expect(first).toBe(projectRepositoryChangedReply('lab', 'other'));
    const second = await replyToChangeRepository('private', rootAccount, 'same-key', alphaId, otherRepoId, connection);
    expect(second).toBe(projectRepositoryCurrent('lab', 'other'));
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(otherRepoId);
    expect(await changedEvents(handle.db)).toHaveLength(1);

    const rolled = await replyToChangeRepository('private', rootAccount, 'same-key', alphaId, repoId, connection);
    expect(rolled).toBeNull();
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(otherRepoId);
    expect(await changedEvents(handle.db)).toHaveLength(1);
  });

  it('INV-22 пустой ключ репозиторий не меняет', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const connection = createProjectRepository(handle.db, silentLogger, clock);
    await sql`
      INSERT INTO repositories (id, owner, name) VALUES (${repoId}, 'lab', 'bot'), (${otherRepoId}, 'lab', 'other')
    `.execute(handle.db);
    await sql`UPDATE projects SET repository_id = ${repoId} WHERE id = ${alphaId}::uuid`.execute(handle.db);
    await expect(
      connection.change({
        telegramUserId: String(rootAccount.id),
        projectId: alphaId,
        repositoryId: otherRepoId,
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      connection.change({
        telegramUserId: String(rootAccount.id),
        projectId: alphaId,
        repositoryId: otherRepoId,
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_REPOSITORY_IDEMPOTENCY_KEY });
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);
    expect(await changedEvents(handle.db)).toEqual([]);
  });
});
