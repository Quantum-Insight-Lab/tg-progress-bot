import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import type { EventJournal } from '../src/events/journal.ts';
import { acceptGithubWebhookHttp, GITHUB_WEBHOOK_PATH } from '../src/github/webhook.ts';
import { createLogger, createProcessLogger, LOG_LEVELS, readLogLevel, secretValues } from '../src/infrastructure/logger.ts';
import { startReconcileLoop } from '../src/infrastructure/reconcile.ts';
import { createScheduler, startSchedulerLoop, SYSTEM_ACTION_IDS, type Scheduler } from '../src/infrastructure/scheduler.ts';
import { readProcessConfig } from '../src/process.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { startTelegramWebhook, TELEGRAM_WEBHOOK_PATH, type WebhookServer } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { captureLog, type LogLine } from './log-lines.ts';

const moment = new Date('2026-09-30T12:00:00.000Z');
const clock: Clock = { now: () => moment };

const BOT_TOKEN = '100200:log-test-bot-token-value';
const TELEGRAM_SECRET = 'log-test-telegram-webhook-secret';
const GITHUB_SECRET = 'log-test-github-webhook-secret';
const KEY_LINE_ONE = 'MIIEpAIBAAKCAQEAlogTestPrivateKeyLineOne';
const KEY_LINE_TWO = 'logTestPrivateKeyLineTwoAbCdEf0123';
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\\n${KEY_LINE_ONE}\\n${KEY_LINE_TWO}\\n-----END RSA PRIVATE KEY-----`;
const DB_SECRET = 'log-test-db-secret@x';
const DB_SECRET_ENCODED = 'log-test-db-secret%40x';

const secretEnv: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
  DATABASE_URL: `postgres://user:${DB_SECRET_ENCODED}@localhost:5432/botdb`,
};

const SECRET_SUBSTRINGS = [
  BOT_TOKEN,
  TELEGRAM_SECRET,
  GITHUB_SECRET,
  PRIVATE_KEY,
  PRIVATE_KEY.replaceAll('\\n', '\n'),
  KEY_LINE_ONE,
  KEY_LINE_TWO,
  DB_SECRET,
  DB_SECRET_ENCODED,
];

function tickingClock(stepMs: number): Clock {
  let current = moment.getTime();
  return {
    now: () => {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
  };
}

function expectNoSecrets(raw: readonly string[]): void {
  const output = raw.join('\n');
  for (const secret of SECRET_SUBSTRINGS) expect(output).not.toContain(secret);
}

describe('B-17 логгер: уровень и запись', () => {
  it('уровень — LOG_LEVEL, по умолчанию info, неизвестное значение — отказ старта', () => {
    expect(readLogLevel({})).toBe('info');
    expect(readLogLevel({ LOG_LEVEL: '' })).toBe('info');
    for (const level of LOG_LEVELS) expect(readLogLevel({ LOG_LEVEL: level })).toBe(level);
    expect(() => readLogLevel({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL — одно из debug, info, warn, error');
    const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's', PORT: '0', SCHEDULER_INTERVAL_MS: '60000' };
    expect(() => readProcessConfig({ ...env, LOG_LEVEL: 'trace' }, clock)).toThrow('LOG_LEVEL');
    expect(() => readProcessConfig(env, clock)).not.toThrow();
  });

  it('строка — один JSON: время ISO по Clock, уровень, шаг, поля; ниже уровня не пишется', () => {
    const log = captureLog({ level: 'info', clock });
    log.logger.debug('step.debug', { value: 1 });
    log.logger.info('step.info', { count: 2, ids: ['A-28'], flag: true, empty: null });
    log.logger.warn('step.warn');
    log.logger.error('step.error', { level: 'debug', slot: 'A-30' }, new Error('причина\nвторая строка'));
    expect(log.raw).toHaveLength(3);
    for (const line of log.raw) expect(line).not.toContain('\n');
    expect(log.lines()).toEqual([
      { time: '2026-09-30T12:00:00.000Z', level: 'info', step: 'step.info', count: 2, ids: ['A-28'], flag: true, empty: null },
      { time: '2026-09-30T12:00:00.000Z', level: 'warn', step: 'step.warn' },
      { time: '2026-09-30T12:00:00.000Z', level: 'error', step: 'step.error', slot: 'A-30', reason: 'причина\nвторая строка' },
    ]);
    const quiet = captureLog({ level: 'error', clock });
    quiet.logger.info('step.info');
    quiet.logger.warn('step.warn');
    quiet.logger.error('step.error');
    expect(quiet.lines().map((line) => line.level)).toEqual(['error']);
  });

  it('значение секрета из окружения в выводе не встречается', () => {
    const raw: string[] = [];
    const logger = createLogger({ level: 'debug', clock, secrets: secretValues(secretEnv), write: (line) => raw.push(line) });
    for (const secret of SECRET_SUBSTRINGS) {
      logger.debug('secret.field', { value: `до ${secret} после`, list: [secret] });
      logger.error('secret.cause', {}, new Error(`https://api.telegram.org/bot${secret}/getMe`));
      logger.warn(`secret.step ${secret}`, {}, secret);
    }
    expect(raw).toHaveLength(SECRET_SUBSTRINGS.length * 3);
    expectNoSecrets(raw);
    expect(raw.join('\n')).toContain('до [скрыто] после');
    expect(secretValues({})).toEqual([]);
    expect(secretValues({ DATABASE_URL: 'postgres://localhost/botdb' })).toEqual([]);
  });

  it('логгер процесса пишет в stdout с уровнем и секретами из окружения', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const logger = createProcessLogger({ ...secretEnv, LOG_LEVEL: 'warn' }, clock);
      logger.info('process.info');
      logger.warn('process.warn', { token: BOT_TOKEN });
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(written[0] ?? '')).toEqual({ time: moment.toISOString(), level: 'warn', step: 'process.warn', token: '[скрыто]' });
    expectNoSecrets(written);
  });
});

describe('B-17 вход HTTP: строка на каждый код ответа', () => {
  const log = captureLog({ secrets: secretValues(secretEnv) });
  const journal: EventJournal = {
    append: () => Promise.reject(new Error('журнал в этом тесте не пишется')),
    refuse: () => undefined,
  };
  const noop = async (): Promise<void> => undefined;
  let githubFails = false;
  let server: WebhookServer;

  beforeAll(async () => {
    const bot = createTelegramBot(BOT_TOKEN, testBotInfo);
    bot.use(async (ctx, next) => {
      if (ctx.update.update_id === 99) throw new Error(`обработчик упал bot${BOT_TOKEN}`);
      await next();
    });
    server = await startTelegramWebhook({
      bot,
      secretToken: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      host: '127.0.0.1',
      logger: log.logger,
      clock: tickingClock(5),
      routes: [
        {
          path: GITHUB_WEBHOOK_PATH,
          handle: (req, res) =>
            acceptGithubWebhookHttp(req, res, {
              secret: GITHUB_SECRET,
              clock,
              isolate: (run) => {
                if (githubFails) return Promise.reject(new Error(`БД недоступна: ${secretEnv.DATABASE_URL ?? ''}`));
                return run(journal, noop, noop, noop, noop, noop, noop);
              },
            }),
        },
      ],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  function update(id: number): string {
    return JSON.stringify({
      update_id: id,
      message: { message_id: id, date: 1700000000, chat: { id: 1, type: 'private' }, from: { id: 2, is_bot: false, first_name: 'A' }, text: 'ping' },
    });
  }

  function signature(body: string): string {
    return `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`;
  }

  async function lineOf(method: string, path: string, body: string, headers: Record<string, string>): Promise<LogLine> {
    const before = log.raw.length;
    const status = await httpStatus(server.port, method, path, body, headers);
    await vi.waitFor(() => expect(log.raw.length).toBe(before + 1));
    const line = log.lines()[before];
    expect(line?.status).toBe(status);
    return line ?? {};
  }

  it('200 — info: метод, путь, код, длительность по Clock', async () => {
    const line = await lineOf('POST', `${TELEGRAM_WEBHOOK_PATH}?x=1`, update(1), { 'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET });
    expect(line).toMatchObject({ level: 'info', step: 'http.request', method: 'POST', path: TELEGRAM_WEBHOOK_PATH, status: 200, durationMs: 5 });
  });

  it('401 — info: чужой секрет Telegram и неверная подпись GitHub', async () => {
    const telegram = await lineOf('POST', TELEGRAM_WEBHOOK_PATH, update(2), { 'X-Telegram-Bot-Api-Secret-Token': 'other' });
    expect(telegram).toMatchObject({ level: 'info', status: 401, path: TELEGRAM_WEBHOOK_PATH });
    const github = await lineOf('POST', GITHUB_WEBHOOK_PATH, '{}', {
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-1',
      'X-Hub-Signature-256': signature('{"other":true}'),
    });
    expect(github).toMatchObject({ level: 'info', status: 401, path: GITHUB_WEBHOOK_PATH });
  });

  it('400 — info: доставка GitHub без события', async () => {
    const line = await lineOf('POST', GITHUB_WEBHOOK_PATH, '{}', { 'X-GitHub-Delivery': 'delivery-2', 'X-Hub-Signature-256': signature('{}') });
    expect(line).toMatchObject({ level: 'info', status: 400, path: GITHUB_WEBHOOK_PATH });
  });

  it('404 — info: чужой путь и не-POST', async () => {
    expect(await lineOf('POST', '/other', '{}', {})).toMatchObject({ level: 'info', status: 404, method: 'POST', path: '/other' });
    expect(await lineOf('GET', TELEGRAM_WEBHOOK_PATH, '', {})).toMatchObject({ level: 'info', status: 404, method: 'GET' });
  });

  it('500 — error с причиной: отказ обработчика Telegram и записи GitHub', async () => {
    const telegram = await lineOf('POST', TELEGRAM_WEBHOOK_PATH, update(99), { 'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET });
    expect(telegram).toMatchObject({ level: 'error', status: 500, path: TELEGRAM_WEBHOOK_PATH });
    expect(String(telegram.reason)).toContain('обработчик упал');
    githubFails = true;
    const github = await lineOf('POST', GITHUB_WEBHOOK_PATH, '{}', { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'delivery-3' });
    githubFails = false;
    expect(github).toMatchObject({ level: 'error', status: 500, path: GITHUB_WEBHOOK_PATH });
    expect(String(github.reason)).toContain('БД недоступна');
  });

  it('заголовки секрета и подписи и секреты из причин в запись не попадают', () => {
    expect(log.raw.length).toBeGreaterThan(0);
    expectNoSecrets(log.raw);
    const output = log.raw.join('\n');
    expect(output).not.toContain(signature('{}'));
    expect(output).not.toContain('X-Telegram-Bot-Api-Secret-Token');
  });
});

describe('B-17 ход планировщика', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SYSTEM_ACTION_IDS)('слот %s: отработал — info, отказ — error с его ID', async (id) => {
    vi.useFakeTimers();
    const ok = captureLog();
    const passing = createScheduler(clock);
    passing.register(id, async () => undefined);
    const first = startSchedulerLoop(passing, 1000, ok.logger);
    await vi.advanceTimersByTimeAsync(1000);
    first.stop();
    expect(ok.lines()).toEqual([expect.objectContaining({ level: 'info', step: 'scheduler.run', ran: [id], failed: [] })]);

    const bad = captureLog();
    const failing = createScheduler(clock);
    failing.register(id, async () => {
      throw new Error(`слот ${id} упал`);
    });
    const second = startSchedulerLoop(failing, 1000, bad.logger);
    await vi.advanceTimersByTimeAsync(1000);
    second.stop();
    expect(bad.steps('scheduler.run')).toEqual([expect.objectContaining({ level: 'info', ran: [], failed: [id] })]);
    expect(bad.steps('scheduler.slot_failed')).toEqual([
      expect.objectContaining({ level: 'error', slot: id, reason: `слот ${id} упал` }),
    ]);
  });

  it('тик, пропущенный из-за незаконченного хода, — debug', async () => {
    vi.useFakeTimers();
    const log = captureLog();
    const scheduler = createScheduler(clock);
    let release: () => void = () => undefined;
    scheduler.register('A-31', () => new Promise((resolve) => {
      release = resolve;
    }));
    const loop = startSchedulerLoop(scheduler, 1000, log.logger);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.lines()).toEqual([expect.objectContaining({ level: 'debug', step: 'scheduler.tick_skipped' })]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    expect(log.steps('scheduler.run')).toEqual([expect.objectContaining({ level: 'info', ran: ['A-31'] })]);
    const quiet = captureLog({ level: 'info' });
    let hold: () => void = () => undefined;
    const slow = createScheduler(clock);
    slow.register('A-31', () => new Promise((resolve) => {
      hold = resolve;
    }));
    const slowLoop = startSchedulerLoop(slow, 1000, quiet.logger);
    await vi.advanceTimersByTimeAsync(2000);
    hold();
    await vi.advanceTimersByTimeAsync(0);
    slowLoop.stop();
    expect(quiet.lines().map((line) => line.step)).toEqual(['scheduler.run']);
  });

  it('отказ хода целиком — error', async () => {
    vi.useFakeTimers();
    const log = captureLog();
    const broken: Scheduler = {
      register: () => undefined,
      run: () => Promise.reject(new Error('ход не начался')),
    };
    const loop = startSchedulerLoop(broken, 1000, log.logger);
    await vi.advanceTimersByTimeAsync(1000);
    loop.stop();
    expect(log.lines()).toEqual([expect.objectContaining({ level: 'error', step: 'scheduler.run_failed', reason: 'ход не начался' })]);
  });
});

describe('B-17 ход сверки на уровне цикла', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('начало и конец — info с длительностью, отказ — error с причиной', async () => {
    vi.useFakeTimers();
    const log = captureLog();
    let fail = false;
    const loop = startReconcileLoop(
      async () => {
        if (fail) throw new Error('GitHub не ответил');
      },
      tickingClock(7),
      1000,
      log.logger,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(log.lines()).toEqual([
      expect.objectContaining({ level: 'info', step: 'reconcile.started' }),
      expect.objectContaining({ level: 'info', step: 'reconcile.finished', durationMs: 7 }),
    ]);
    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    loop.stop();
    expect(log.lines().slice(2)).toEqual([
      expect.objectContaining({ level: 'info', step: 'reconcile.started' }),
      expect.objectContaining({ level: 'error', step: 'reconcile.failed', durationMs: 7, reason: 'GitHub не ответил' }),
    ]);
  });
});
