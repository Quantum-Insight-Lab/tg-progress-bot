import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GITHUB_WEBHOOK_PATH } from '../src/github/webhook.ts';
import { applyMigrations, listMigrationFiles } from '../src/infrastructure/apply-migrations.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole, JOURNAL_ROLE, withMigrationSql, type MigrationSql } from '../src/infrastructure/db.ts';
import { registerBotWebhook, webhookUrls } from '../src/infrastructure/webhook-host.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';

const WRITE_CALLS = [
  'issues.create',
  'issues.update',
  'issues.createComment',
  'pulls.create',
  'pulls.merge',
  'updateWebhookConfigForApp',
  'new App(',
  "method: 'POST'",
  "method: 'PATCH'",
  "method: 'PUT'",
  "method: 'DELETE'",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pgliteSql(pglite: PGlite): MigrationSql {
  return {
    async exec(text) {
      await pglite.exec(text);
    },
    async query(text, params = []) {
      const result = await pglite.query(text, [...params]);
      return result.rows.map((row) => (isRecord(row) ? { ...row } : {}));
    },
  };
}

const BACKUP_COPIES = 7;
const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];

function compose(): { services: Record<string, Record<string, unknown>>; volumes: Record<string, unknown> } {
  const root: unknown = parseYaml(readFileSync('docker-compose.yml', 'utf8'));
  if (!isRecord(root) || !isRecord(root.services)) throw new Error('compose без services');
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, service] of Object.entries(root.services)) {
    if (!isRecord(service)) throw new Error(`сервис ${name} не объект`);
    services[name] = service;
  }
  return { services, volumes: isRecord(root.volumes) ? root.volumes : {} };
}

function field(services: Record<string, Record<string, unknown>>, name: string): Record<string, unknown> {
  const service = services[name];
  if (service === undefined) throw new Error(`нет сервиса ${name}`);
  return service;
}

function environment(service: Record<string, unknown>): Record<string, unknown> {
  return isRecord(service.environment) ? service.environment : {};
}

function exampleEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) throw new Error(trimmed);
    const key = trimmed.slice(0, eq);
    env[key] = trimmed.slice(eq + 1);
  }
  return env;
}

describe('развёртывание', () => {
  const opened: Kysely<Database>[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.destroy()));
  });

  it('файлы миграций идут по номеру и применяются один раз', async () => {
    const onDisk = readdirSync('migrations')
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(listMigrationFiles()).toEqual(onDisk);
    const pglite = new PGlite();
    const executor = pgliteSql(pglite);
    const first = await applyMigrations(executor);
    expect(first).toEqual(onDisk);
    expect(await applyMigrations(executor)).toEqual([]);
    const names = await executor.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(names.map((row) => row.name)).toEqual([...onDisk]);
  });

  it('INV-28 шаг миграций не даёт роли журнала править события', async () => {
    const pglite = new PGlite();
    await applyMigrations(pgliteSql(pglite));
    await pglite.exec(`INSERT INTO events (
      id, source, event_type, payload, created_at, idempotency_key,
      causation_id, correlation_id, schema_version, actor_id, actor_role, subject_entity, subject_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000001', 'telegram', 'task.checked', '{}', '2026-09-28T00:00:00Z',
      'deploy-1', NULL, NULL, 1, 'actor', 'member', 'task', 'task-1'
    )`);
    const db = new Kysely<Database>({
      dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
    });
    opened.push(db);
    await expect(sql`UPDATE events SET source = 'hacked'`.execute(db)).rejects.toThrow(/permission denied|42501/);
    await expect(sql`DELETE FROM events`.execute(db)).rejects.toThrow(/permission denied|42501/);
    const source = await sql<{ source: string }>`SELECT source FROM events`.execute(db);
    expect(source.rows[0]?.source).toBe('telegram');
  });

  it('без DATABASE_URL шаг миграций не открывает пул', async () => {
    await expect(withMigrationSql('', async () => [])).rejects.toThrow('DATABASE_URL не задан');
  });

  it('оба webhook на одном TLS-хосте, setWebhook только у бота', async () => {
    const urls = webhookUrls('https://bot.example.com', TELEGRAM_WEBHOOK_PATH, GITHUB_WEBHOOK_PATH);
    expect(new URL(urls.telegramUrl).host).toBe(new URL(urls.githubUrl).host);
    expect(urls.telegramUrl).toBe('https://bot.example.com/telegram/webhook');
    expect(urls.githubUrl).toBe('https://bot.example.com/github/webhook');
    expect(() => webhookUrls('http://bot.example.com', TELEGRAM_WEBHOOK_PATH, GITHUB_WEBHOOK_PATH)).toThrow('только TLS');
    const called: string[] = [];
    await registerBotWebhook(urls, 'tg-secret', 'gh-secret', async (url) => {
      called.push(url);
    });
    expect(called).toEqual([urls.telegramUrl]);
    await expect(registerBotWebhook(urls, '', 'gh-secret', async () => undefined)).rejects.toThrow('TELEGRAM_WEBHOOK_SECRET не задан');
    await expect(registerBotWebhook(urls, 'tg-secret', '', async () => undefined)).rejects.toThrow('GITHUB_WEBHOOK_SECRET не задан');
  });

  it('INV-21 регистрация webhook не пишет в GitHub', () => {
    const sources = ['src/infrastructure/webhook-host.ts', 'src/register-webhooks-main.ts', 'src/migrate-main.ts', 'src/infrastructure/apply-migrations.ts']
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const needle of WRITE_CALLS) expect(sources).not.toContain(needle);
    expect(sources).toContain('setWebhook');
    expect(sources).not.toContain('octokit');
  });

  it('образ процесса, миграции отдельным шагом, пример без секретов', () => {
    const image = readFileSync('Dockerfile', 'utf8');
    expect(image).toContain('FROM node:22');
    expect(image).toContain('src/main.ts');
    expect(image).not.toContain('migrate-main');
    const compose = readFileSync('docker-compose.yml', 'utf8');
    expect(compose).toContain('src/migrate-main.ts');
    const caddy = readFileSync('deploy/Caddyfile', 'utf8');
    expect(caddy).toContain('/telegram/webhook');
    expect(caddy).toContain('/github/webhook');
    expect(caddy).toContain('reverse_proxy app:8080');
    const env = exampleEnv(readFileSync('.env.example', 'utf8'));
    for (const key of SECRET_KEYS) {
      expect(env[key]).toBe('');
    }
    expect(env.PUBLIC_WEBHOOK_ORIGIN).toBe('https://bot.example.com');
    expect(readFileSync('.env.example', 'utf8')).not.toMatch(/ghp_|github_pat_|\d{6,}:[A-Za-z0-9_-]{20,}/);
    const urls = webhookUrls(env.PUBLIC_WEBHOOK_ORIGIN ?? '', env.TELEGRAM_WEBHOOK_PATH ?? '', GITHUB_WEBHOOK_PATH);
    expect(new URL(urls.telegramUrl).host).toBe(new URL(urls.githubUrl).host);
    expect(new URL(urls.githubUrl).pathname).toBe(GITHUB_WEBHOOK_PATH);
  });

  it('INV-28 журнал в именованном томе и в копии по расписанию хоста', () => {
    const { services, volumes } = compose();
    expect(Object.keys(volumes)).toContain('pgdata');
    expect(field(services, 'postgres').volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
    const readme = readFileSync('deploy/README.md', 'utf8');
    const cron = readme.split('\n').filter((line) => line.startsWith('0 3 * * * '));
    expect(cron).toHaveLength(1);
    const line = cron[0] ?? '';
    expect(line).toContain("pg_dump -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -Fc' > /var/backups/tg-bot/.partial && mv ");
    expect(line).toContain('/var/backups/tg-bot/journal-$(date +\\%F).dump');
    expect(line).toContain(`sort -r | tail -n +${BACKUP_COPIES + 1} | xargs -r rm --`);
    const role = `CREATE ROLE ${JOURNAL_ROLE} NOLOGIN`;
    expect(readFileSync('migrations/001_events.sql', 'utf8')).toContain(role);
    expect(readme).toContain(`SELECT '${role}' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${JOURNAL_ROLE}') \\gexec`);
    expect(readme).toContain("pg_restore -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" --exit-on-error");
    expect(readme).not.toContain('--no-acl');
  });

  it('перезапуск после падения и перезагрузки, migrate отдельным шагом, ротация логов у каждого сервиса', () => {
    const { services } = compose();
    for (const name of ['postgres', 'app', 'caddy']) expect(field(services, name).restart).toBe('unless-stopped');
    expect(field(services, 'migrate').restart).toBe('no');
    expect(Object.keys(services).sort()).toEqual(['app', 'caddy', 'migrate', 'postgres', 'register-webhooks']);
    for (const service of Object.values(services)) {
      expect(service.logging).toEqual({ driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } });
    }
  });

  it('внешний прокси: Caddy только в профиле caddy, порт app только на 127.0.0.1, nginx ведёт оба пути', () => {
    const { services } = compose();
    expect(field(services, 'caddy').profiles).toEqual(['caddy']);
    for (const name of ['postgres', 'migrate', 'app']) expect(field(services, name).profiles).toBeUndefined();
    expect(field(services, 'app').ports).toEqual(['127.0.0.1:${APP_HOST_PORT:-8088}:8080']);
    const env = exampleEnv(readFileSync('.env.example', 'utf8'));
    expect(env.COMPOSE_PROFILES).toBe('caddy');
    expect(env.APP_HOST_PORT).toBe('8088');
    const nginx = readFileSync('deploy/nginx.conf.example', 'utf8');
    for (const path of [TELEGRAM_WEBHOOK_PATH, GITHUB_WEBHOOK_PATH]) {
      const block = nginx.split(`location = ${path} {`)[1]?.split('}')[0] ?? '';
      expect(block).toContain(`proxy_pass http://127.0.0.1:${env.APP_HOST_PORT};`);
    }
    expect(nginx.split(`location = ${GITHUB_WEBHOOK_PATH} {`)[1]?.split('}')[0]).toContain('client_max_body_size 25m;');
    expect(nginx.match(/proxy_pass /g)).toHaveLength(2);
    expect(nginx).toContain('return 404;');
    expect(nginx).toContain('server_name bot.example.com;');
  });

  it('register-webhooks из образа: профиль tools, окружение из .env, значений секретов в compose нет', () => {
    const { services } = compose();
    const register = field(services, 'register-webhooks');
    expect(register.profiles).toEqual(['tools']);
    expect(register.build).toBe(field(services, 'app').build);
    expect(register.command).toEqual(['node', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/register-webhooks-main.ts']);
    const main = readFileSync('src/register-webhooks-main.ts', 'utf8');
    const read = [...main.matchAll(/process\.env(?:, |\.)'?([A-Z_]+)'?/g)].map((match) => match[1] ?? '');
    expect(read.length).toBeGreaterThan(0);
    expect(Object.keys(environment(register)).sort()).toEqual([...new Set(read)].sort());
    for (const service of Object.values(services)) {
      for (const [key, value] of Object.entries(environment(service))) {
        if (SECRET_KEYS.includes(key) || key === 'PUBLIC_WEBHOOK_ORIGIN') expect(value).toBe(`\${${key}:-}`);
      }
    }
  });
});
