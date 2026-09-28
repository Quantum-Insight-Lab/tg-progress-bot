import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defineRepository,
  repositoryMirrorKey,
  sameRepositoryMirror,
  showInstallationRepositories,
  unconfiguredInstallationSource,
  type InstallationAudience,
  type InstallationRepositorySource,
  type Repository,
  type RepositoryStore,
} from '../src/domain/github/repository.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import {
  assertGithubAppCredentials,
  createGithubAppClient,
  readGithubAppCredentials,
  type GithubAppCredentials,
} from '../src/github/client.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { countRepositories, createInstallationRepositories } from '../src/infrastructure/installation-repositories.ts';
import {
  readEventsMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readRepositoriesMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { registerRoot } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import {
  parseRepositoriesMessage,
  renderRepositories,
  replyToRepositories,
  REPOSITORIES_ACCESS,
  REPOSITORIES_APP,
  REPOSITORIES_EMPTY,
  REPOSITORIES_HEADING,
  REPOSITORIES_UNAVAILABLE,
} from '../src/telegram/installation-repositories.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };

const rootId = '00000000-0000-4000-8000-000000000001';
const leadId = '00000000-0000-4000-8000-000000000002';
const memberId = '00000000-0000-4000-8000-000000000003';
const alphaId = '00000000-0000-4000-8000-000000000010';
const betaId = '00000000-0000-4000-8000-000000000011';

const appKey = '-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----';

function memoryStore(): RepositoryStore & { rows: Repository[] } {
  const rows: Repository[] = [];
  return {
    rows,
    async upsert(repository) {
      const index = rows.findIndex((item) => item.id === repository.id);
      if (index < 0) rows.push({ ...repository });
      else rows[index] = { ...repository };
    },
    async list() {
      return rows.map((item) => ({ ...item }));
    },
  };
}

function audience(viewer: { isRoot: boolean; leadsProject: boolean } | null): InstallationAudience {
  return {
    async viewer() {
      return viewer;
    },
  };
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readRepositoriesMigration());
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
  await registerRoot(db, { id: rootId, telegramUserId: '1001', name: 'Аня' });
  await sql`
    INSERT INTO users (id, telegram_user_id, name, is_root)
    VALUES (${leadId}::uuid, 1002, 'Борис', false),
           (${memberId}::uuid, 1003, 'Вера', false)
  `.execute(db);
  await sql`
    INSERT INTO projects (id, name, description, timezone, created_at)
    VALUES (${alphaId}::uuid, 'Альфа', '', 'Europe/Moscow', now()),
           (${betaId}::uuid, 'Бета', '', 'Europe/Moscow', now())
  `.execute(db);
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role)
    VALUES (${'00000000-0000-4000-8000-0000000000a2'}::uuid, ${betaId}::uuid, ${leadId}::uuid, 'lead'),
           (${'00000000-0000-4000-8000-0000000000a3'}::uuid, ${alphaId}::uuid, ${memberId}::uuid, 'member')
  `.execute(db);
}

describe('INV-03 зеркало репозитория одно на id', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterAll(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-03 два просмотра видят один репозиторий, проекта в ключе нет', async () => {
    expect(repositoryMirrorKey(defineRepository({ id: '42', owner: ' acme ', name: ' bot ' }))).toBe('42');
    expect(defineRepository({ id: '42', owner: 'acme', name: 'bot' })).toEqual({ id: '42', owner: 'acme', name: 'bot' });
    expect(() => defineRepository({ id: '0', owner: 'acme', name: 'bot' })).toThrow(DomainError);
    expect(() => defineRepository({ id: '42', owner: ' ', name: 'bot' })).toThrow(DomainError);

    const handle = await openDb();
    opened.push(handle);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'repositories'
      ORDER BY column_name
    `.execute(handle.db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(['id', 'name', 'owner']);

    await seed(handle.db);
    const usersBefore = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(handle.db);
    const membersBefore = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM project_members`.execute(handle.db);

    let name = 'bot';
    const source: InstallationRepositorySource = {
      async list() {
        return [{ id: '42', owner: 'acme', name }];
      },
    };
    const actions = createInstallationRepositories(handle.db, source);
    const asRoot = await actions.show({ telegramUserId: '1001', chat: 'private', idempotencyKey: 'r1' });
    name = 'api';
    const asLead = await actions.show({ telegramUserId: '1002', chat: 'private', idempotencyKey: 'r2' });

    expect(sameRepositoryMirror(asRoot, asLead)).toBe(true);
    expect(asLead).toEqual([{ id: '42', owner: 'acme', name: 'api' }]);
    expect(await countRepositories(handle.db)).toBe(1);
    expect(repositoryMirrorKey(asRoot[0] ?? asLead[0]!)).toBe(repositoryMirrorKey(asLead[0]!));

    const usersAfter = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM users`.execute(handle.db);
    const membersAfter = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM project_members`.execute(handle.db);
    expect(Number(usersAfter.rows[0]?.n)).toBe(Number(usersBefore.rows[0]?.n));
    expect(Number(membersAfter.rows[0]?.n)).toBe(Number(membersBefore.rows[0]?.n));

    const duplicate = sql`INSERT INTO repositories (id, owner, name) VALUES ('42', 'other', 'name')`.execute(handle.db);
    await expect(duplicate).rejects.toThrow(/repositories_pkey|23505/);
    const sameName = sql`INSERT INTO repositories (id, owner, name) VALUES ('7', 'acme', 'api')`.execute(handle.db);
    await expect(sameName).rejects.toThrow(/repositories_owner_name_unique|23505/);
    const blank = sql`INSERT INTO repositories (id, owner, name) VALUES ('8', '   ', 'api')`.execute(handle.db);
    await expect(blank).rejects.toThrow(/repositories_owner_not_blank|23514/);
    expect(await countRepositories(handle.db)).toBe(1);
  });
});

describe('INV-19 репозитории установки смотрит руководитель в личке', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterAll(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-19 участник список не получает, корень и руководитель видят owner/name', async () => {
    const store = memoryStore();
    let calls = 0;
    const source: InstallationRepositorySource = {
      async list() {
        calls += 1;
        return [{ id: '42', owner: 'acme', name: 'bot' }];
      },
    };
    await expect(
      showInstallationRepositories(audience({ isRoot: false, leadsProject: false }), source, store, {
        telegramUserId: '1003',
        chat: 'private',
        idempotencyKey: 'm1',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_ACCESS });
    expect(calls).toBe(0);
    expect(store.rows).toEqual([]);

    await expect(
      showInstallationRepositories(audience({ isRoot: true, leadsProject: false }), source, store, {
        telegramUserId: '1001',
        chat: 'supergroup',
        idempotencyKey: 'g1',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_CHAT });
    expect(calls).toBe(0);

    const shown = await showInstallationRepositories(audience({ isRoot: false, leadsProject: true }), source, store, {
      telegramUserId: '1002',
      chat: 'private',
      idempotencyKey: 'l1',
    });
    expect(shown).toEqual([{ id: '42', owner: 'acme', name: 'bot' }]);
    expect(calls).toBe(1);

    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const actions = createInstallationRepositories(handle.db, source);
    const refused = await replyToRepositories('private', { id: 1003, is_bot: false }, 'm2', actions);
    expect(refused).toBe(REPOSITORIES_ACCESS);
    expect(refused).not.toContain('acme');
    expect(await countRepositories(handle.db)).toBe(0);

    const quiet = await replyToRepositories('supergroup', { id: 1001, is_bot: false }, 'g2', actions);
    expect(quiet).toBeNull();
    expect(await countRepositories(handle.db)).toBe(0);

    const listed = await replyToRepositories('private', { id: 1001, is_bot: false }, 'r3', actions);
    expect(listed).toBe(`${REPOSITORIES_HEADING}\nacme/bot`);
    expect(await countRepositories(handle.db)).toBe(1);
    expect(parseRepositoriesMessage(REPOSITORIES_HEADING)).toBe(true);
    expect(parseRepositoriesMessage(`${REPOSITORIES_HEADING}\nАльфа`)).toBe(false);
    expect(renderRepositories([])).toBe(REPOSITORIES_EMPTY);
  });
});

describe('INV-22 повтор списка установки не плодит зеркало', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterAll(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-22 тот же репозиторий второй раз не создаёт строку и не пишет событие подключения', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const source: InstallationRepositorySource = {
      async list() {
        return [
          { id: '42', owner: 'acme', name: 'bot' },
          { id: '42', owner: 'acme', name: 'bot' },
        ];
      },
    };
    const actions = createInstallationRepositories(handle.db, source);
    const first = await actions.show({ telegramUserId: '1001', chat: 'private', idempotencyKey: 'once' });
    const second = await actions.show({ telegramUserId: '1001', chat: 'private', idempotencyKey: 'once' });
    expect(first).toEqual([{ id: '42', owner: 'acme', name: 'bot' }]);
    expect(second).toEqual(first);
    expect(await countRepositories(handle.db)).toBe(1);

    const connected = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events
      WHERE event_type = ${EVENT_TYPES.PROJECT_REPOSITORY_CONNECTED}
    `.execute(handle.db);
    expect(Number(connected.rows[0]?.n)).toBe(0);

    await expect(
      actions.show({ telegramUserId: '1001', chat: 'private', idempotencyKey: '   ' }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_IDEMPOTENCY_KEY });
    expect(await countRepositories(handle.db)).toBe(1);
  });
});

describe('GitHub App, не личный токен', () => {
  it('учётные данные приложения не читают личный токен и не принимают его строку', async () => {
    expect(readGithubAppCredentials({ GITHUB_TOKEN: 'ghp_secret', GH_TOKEN: 'github_pat_secret' })).toBeNull();
    expect(readGithubAppCredentials({ GITHUB_APP_ID: ' 123 ', GITHUB_APP_PRIVATE_KEY: appKey })).toEqual({
      appId: '123',
      privateKey: appKey,
    });
    expect(() => assertGithubAppCredentials({ appId: '123', privateKey: 'ghp_secret' })).toThrow(DomainError);
    expect(() => assertGithubAppCredentials({ appId: 'github_pat_x', privateKey: appKey })).toThrow(DomainError);
    await expect(unconfiguredInstallationSource().list()).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_APP });

    const seen: GithubAppCredentials[] = [];
    const client = createGithubAppClient({ appId: '123', privateKey: appKey }, (credentials) => {
      seen.push(credentials);
      return {
        eachRepository: {
          async *iterator() {
            yield { repository: { id: '42', name: 'bot', owner: { login: 'acme' } } };
            yield { repository: { id: '7', name: 'lib', owner: null } };
          },
        },
      };
    });
    await expect(client.list()).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_OWNER_BLANK });
    expect(seen).toEqual([{ appId: '123', privateKey: appKey }]);
    expect(seen[0]).not.toHaveProperty('token');

    const failing = createGithubAppClient({ appId: '123', privateKey: appKey }, () => ({
      eachRepository: {
        iterator() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<{ repository: { id: string; name: string; owner: { login: string } | null } }>> {
                  return Promise.reject(new Error('сеть'));
                },
              };
            },
          };
        },
      },
    }));
    await expect(failing.list()).rejects.toMatchObject({ code: DOMAIN_ERROR.REPOSITORY_UNAVAILABLE });
    expect(REPOSITORIES_APP).toContain('GitHub App');
    expect(REPOSITORIES_UNAVAILABLE).not.toContain('token');
  });
});

describe('бот показывает репозитории установки', () => {
  const sent: string[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('в личке руководителя — owner/name, участнику — отказ без имён', async () => {
    const handle = await openDb();
    opened.push(handle);
    await seed(handle.db);
    const source: InstallationRepositorySource = {
      async list() {
        return [{ id: '42', owner: 'acme', name: 'bot' }];
      },
    };
    running = await startProcess({
      ...readProcessConfig(
        {
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
          PORT: '0',
          SCHEDULER_INTERVAL_MS: '60000',
        },
        clock,
      ),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: handle.db,
      installationSource: source,
    });
    running.bot.api.config.use((async (_prev, method, payload) => {
      if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') sent.push(payload.text);
      if (method === 'sendMessage') {
        return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: 1, type: 'private' } } };
      }
      return { ok: true, result: true };
    }) as Transformer);

    async function post(body: string): Promise<string[]> {
      const mark = sent.length;
      const status = await httpStatus(running?.port ?? 0, 'POST', TELEGRAM_WEBHOOK_PATH, body, {
        'X-Telegram-Bot-Api-Secret-Token': 'secret',
      });
      expect(status).toBe(200);
      return sent.slice(mark);
    }

    function message(updateId: number, accountId: number, chatType: string): string {
      return JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1700000000,
          chat: { id: accountId, type: chatType },
          from: { id: accountId, is_bot: false, first_name: 'Кто' },
          text: REPOSITORIES_HEADING,
        },
      });
    }

    const rootReply = await post(message(901, 1001, 'private'));
    expect(rootReply).toEqual([`${REPOSITORIES_HEADING}\nacme/bot`]);
    const memberReply = await post(message(902, 1003, 'private'));
    expect(memberReply).toEqual([REPOSITORIES_ACCESS]);
    expect(memberReply[0]).not.toContain('acme');
    const groupReply = await post(message(903, 1001, 'supergroup'));
    expect(groupReply).toEqual([]);
    expect(await countRepositories(handle.db)).toBe(1);
  });
});
