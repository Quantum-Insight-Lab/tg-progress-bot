import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstallationRepositorySource } from '../src/domain/github/repository.ts';
import {
  PROJECT_REPOSITORY_ACTOR_ROLE,
  projectRepositoryShareKey,
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
import { NEW_PROJECT_HEADING, parseNewProjectMessage } from '../src/telegram/new-project.ts';
import { REPOSITORIES_HEADING } from '../src/telegram/installation-repositories.ts';
import {
  connectRepositoryData,
  openProjectRepositoryStep,
  parseConnectRepositoryData,
  parseProjectRepositoryMessage,
  parseSkipRepositoryData,
  PROJECT_REPOSITORY_ACTOR,
  PROJECT_REPOSITORY_ALREADY,
  PROJECT_REPOSITORY_HEADING,
  PROJECT_REPOSITORY_SKIP_LABEL,
  PROJECT_REPOSITORY_SKIPPED,
  PROJECT_REPOSITORY_STEP,
  projectRepositoryConnectedReply,
  projectRepositoryCurrent,
  projectRepositoryKeyboard,
  replyToConnectRepository,
  replyToSkipRepository,
  skipRepositoryData,
} from '../src/telegram/connect-repository.ts';

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
    connection: createProjectRepository(db, clock),
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

async function connectedEvents(db: Kysely<Database>): Promise<
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
    WHERE event_type = ${EVENT_TYPES.PROJECT_REPOSITORY_CONNECTED}
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

describe('INV-19 репозиторий при заведении подключает руководитель', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 в личке подключает корень или руководитель этого проекта, исполнитель — нет', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection, installation } = actionsOf(handle.db);

    const outside = await openProjectRepositoryStep('group', rootAccount, 'outside', 'Альфа', connection, installation);
    expect(outside).toBeNull();
    expect(await repositoryIdOf(handle.db, alphaId)).toBeNull();

    const step = await openProjectRepositoryStep('private', rootAccount, 'open-alpha', 'Альфа', connection, installation);
    expect(step?.text).toContain(PROJECT_REPOSITORY_STEP);
    expect(step?.markup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      'lab/bot',
      'lab/other',
      PROJECT_REPOSITORY_SKIP_LABEL,
    ]);
    const choice = callbackData(step?.markup?.inline_keyboard[0]?.[0]);
    if (choice === undefined) throw new Error('кнопка репозитория');
    expect(parseConnectRepositoryData(choice)).toEqual({ projectId: alphaId, repositoryId: repoId });

    const connected = await replyToConnectRepository('private', rootAccount, 'connect-alpha', alphaId, repoId, connection);
    expect(connected).toBe(projectRepositoryConnectedReply('lab', 'bot'));
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);
    expect(await connectedEvents(handle.db)).toEqual([
      {
        idempotencyKey: 'connect-alpha',
        payload: { project_id: alphaId, repository_id: repoId },
        actorId: rootId,
        actorRole: PROJECT_REPOSITORY_ACTOR_ROLE,
        subjectId: alphaId,
      },
    ]);

    const member = await replyToConnectRepository('private', memberAccount, 'member-alpha', alphaId, otherRepoId, connection);
    expect(member).toBe(PROJECT_REPOSITORY_ACTOR);
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);

    const leadOnAlpha = await replyToConnectRepository('private', leadAccount, 'lead-alpha', alphaId, otherRepoId, connection);
    expect(leadOnAlpha).toBe(PROJECT_REPOSITORY_ACTOR);

    const lead = await replyToConnectRepository('private', leadAccount, 'connect-beta', betaId, repoId, connection);
    expect(lead).toBe(projectRepositoryConnectedReply('lab', 'bot'));
    expect(await repositoryIdOf(handle.db, betaId)).toBe(repoId);
    expect((await connectedEvents(handle.db)).map((event) => event.actorId)).toEqual([rootId, leadUserId]);
  });
});

describe('INV-20 шаг репозитория можно пропустить', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-20 пропуск не требует репозитория и не пишет событие подключения', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection, installation } = actionsOf(handle.db);

    expect(parseProjectRepositoryMessage(`${NEW_PROJECT_HEADING}\nАльфа\n\nEurope/Moscow`)).toBeNull();
    expect(parseNewProjectMessage(`${PROJECT_REPOSITORY_HEADING}\nАльфа`)).toBeNull();
    expect(parseProjectRepositoryMessage(REPOSITORIES_HEADING)).toBeNull();
    expect(parseProjectRepositoryMessage(`${PROJECT_REPOSITORY_HEADING}\nАльфа`)).toEqual({ projectName: 'Альфа' });

    const step = await openProjectRepositoryStep('private', rootAccount, 'open-gamma', 'Гамма', connection, installation);
    const skipData = callbackData(step?.markup?.inline_keyboard.at(-1)?.[0]);
    expect(skipData).toBe(skipRepositoryData(gammaId));
    expect(parseSkipRepositoryData(skipData ?? '')).toEqual({ projectId: gammaId });

    const skipped = await replyToSkipRepository('private', rootAccount, 'skip-gamma', gammaId, connection);
    expect(skipped).toBe(PROJECT_REPOSITORY_SKIPPED);
    expect(await repositoryIdOf(handle.db, gammaId)).toBeNull();
    expect(projectRepositoryShareKey(await repositoryIdOf(handle.db, gammaId))).toBeNull();
    expect(await connectedEvents(handle.db)).toEqual([]);

    const again = await replyToSkipRepository('private', rootAccount, 'skip-gamma-again', gammaId, connection);
    expect(again).toBe(PROJECT_REPOSITORY_SKIPPED);
    expect(await repositoryIdOf(handle.db, gammaId)).toBeNull();
    const name = await sql<{ name: string }>`SELECT name FROM projects WHERE id = ${gammaId}::uuid`.execute(handle.db);
    expect(name.rows[0]?.name).toBe('Гамма');
  });
});

describe('INV-03 зеркало одно на репозиторий, у проекта только ссылка', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-03 два проекта одного репозитория дают одну долю, без репозитория проект допустим', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection, installation } = actionsOf(handle.db);
    const peopleBefore = await memberRows(handle.db);

    await openProjectRepositoryStep('private', rootAccount, 'list', 'Альфа', connection, installation);
    await replyToConnectRepository('private', rootAccount, 'alpha-42', alphaId, repoId, connection);
    await replyToConnectRepository('private', leadAccount, 'beta-42', betaId, repoId, connection);

    const alpha = await repositoryIdOf(handle.db, alphaId);
    const beta = await repositoryIdOf(handle.db, betaId);
    const gamma = await repositoryIdOf(handle.db, gammaId);
    expect(projectRepositoryShareKey(alpha)).toBe(repoId);
    expect(projectRepositoryShareKey(beta)).toBe(projectRepositoryShareKey(alpha));
    expect(projectRepositoryShareKey(gamma)).toBeNull();

    const mirror = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM repositories`.execute(handle.db);
    expect(Number(mirror.rows[0]?.n)).toBe(2);
    const shared = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM repositories WHERE id = ${repoId}
    `.execute(handle.db);
    expect(Number(shared.rows[0]?.n)).toBe(1);
    const linked = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM projects WHERE repository_id = ${repoId}
    `.execute(handle.db);
    expect(Number(linked.rows[0]?.n)).toBe(2);

    expect(await memberRows(handle.db)).toEqual(peopleBefore);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects'
    `.execute(handle.db);
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('repository_id');
    expect(names).not.toContain('owner');
    expect(names).not.toContain('default_branch_ci');

    const second = await replyToConnectRepository('private', rootAccount, 'alpha-43', alphaId, otherRepoId, connection);
    expect(second).toBe(PROJECT_REPOSITORY_ALREADY);
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);

    const indexes = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'projects' AND indexdef ILIKE '%repository_id%'
    `.execute(handle.db);
    expect(indexes.rows.every((row) => !row.indexdef.toLowerCase().includes('unique'))).toBe(true);

    const blank = sql`UPDATE projects SET repository_id = ' ' WHERE id = ${gammaId}::uuid`.execute(handle.db);
    await expect(blank).rejects.toThrow(/projects_repository_id_github|23514/);
    const missing = sql`UPDATE projects SET repository_id = '99' WHERE id = ${gammaId}::uuid`.execute(handle.db);
    await expect(missing).rejects.toThrow(/projects_repository_id_fkey|23503/);
    expect(await repositoryIdOf(handle.db, gammaId)).toBeNull();
    expect(connectRepositoryData(alphaId, repoId)).toBe(`rc:${alphaId}:${repoId}`);
  });
});

describe('INV-22 повтор подключения репозитория не применяется второй раз', () => {
  const opened: Handle[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же ключ не пишет второе событие и не меняет ссылку', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const { connection, installation } = actionsOf(handle.db);
    await openProjectRepositoryStep('private', rootAccount, 'list-22', 'Альфа', connection, installation);

    const first = await replyToConnectRepository('private', rootAccount, 'same-key', alphaId, repoId, connection);
    expect(first).toBe(projectRepositoryConnectedReply('lab', 'bot'));
    const second = await replyToConnectRepository('private', rootAccount, 'same-key', alphaId, repoId, connection);
    expect(second).toBe(projectRepositoryCurrent('lab', 'bot'));
    expect(await repositoryIdOf(handle.db, alphaId)).toBe(repoId);
    expect(await connectedEvents(handle.db)).toHaveLength(1);

    const keyboard = projectRepositoryKeyboard(alphaId, [{ id: repoId, owner: 'lab', name: 'bot' }]);
    expect(callbackData(keyboard.inline_keyboard[0]?.[0])).toBe(connectRepositoryData(alphaId, repoId));
  });

  it('INV-22 пустой ключ репозиторий не подключает', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const connection = createProjectRepository(handle.db, clock);
    await sql`
      INSERT INTO repositories (id, owner, name) VALUES (${repoId}, 'lab', 'bot')
    `.execute(handle.db);
    await expect(
      connection.connect({
        telegramUserId: String(rootAccount.id),
        projectId: alphaId,
        repositoryId: repoId,
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      connection.connect({
        telegramUserId: String(rootAccount.id),
        projectId: alphaId,
        repositoryId: repoId,
        chat: 'private',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.PROJECT_REPOSITORY_IDEMPOTENCY_KEY });
    expect(await repositoryIdOf(handle.db, alphaId)).toBeNull();
    expect(await connectedEvents(handle.db)).toEqual([]);
  });
});
