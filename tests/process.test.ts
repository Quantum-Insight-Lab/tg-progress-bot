import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/github/webhook.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { HEALTH_PATH, TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { captureLog } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T00:00:00.000Z') };
const log = captureLog({ clock });

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    PORT: '0',
    SCHEDULER_INTERVAL_MS: '60000',
    ...overrides,
  };
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith('.ts') ? [path.split('\\').join('/')] : [];
  });
}

describe('один процесс', () => {
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
  });

  it('поднимает webhook, движок и планировщик и второй раз не стартует', async () => {
    running = await startProcess({
      ...readProcessConfig(env(), clock),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      logger: log.logger,
      reconcileSource: null,
    });
    expect(running.port).toBeGreaterThan(0);
    expect(running.engine.tasks.id).toBe('tasks');
    expect(running.engine.githubMirror.scope).toBe('repository');
    expect(running.engine.eventProcessor.id).toBe('event-processor');
    expect(running.engine.reportGenerator.id).toBe('report-generator');
    const seen: number[] = [];
    running.bot.use(async (ctx) => {
      seen.push(ctx.update.update_id);
    });
    const body = JSON.stringify({
      update_id: 7,
      message: {
        message_id: 7,
        date: 1700000000,
        chat: { id: 1, type: 'private' },
        from: { id: 2, is_bot: false, first_name: 'A' },
        text: 'ping',
      },
    });
    const status = await httpStatus(running.port, 'POST', TELEGRAM_WEBHOOK_PATH, body, {
      'X-Telegram-Bot-Api-Secret-Token': 'secret',
    });
    expect(status).toBe(200);
    expect(seen).toEqual([7]);
    const github = await httpStatus(running.port, 'POST', GITHUB_WEBHOOK_PATH, '{}', {
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'delivery-1',
    });
    expect(github).toBe(404);
    expect(await httpStatus(running.port, 'GET', HEALTH_PATH, '', {})).toBe(200);
    await expect(startProcess(readProcessConfig(env(), clock))).rejects.toThrow('процесс уже запущен');
  });

  it('B-17 после старта — строка старта и строка на каждый запрос; стоп — сигнал и итог закрытия', async () => {
    const started = running;
    if (started === undefined) throw new Error('процесс не запущен');
    expect(log.steps('process.started')).toEqual([
      {
        time: '2026-09-28T00:00:00.000Z',
        level: 'info',
        step: 'process.started',
        port: started.port,
        host: '127.0.0.1',
        telegramWebhookPath: TELEGRAM_WEBHOOK_PATH,
        githubWebhookPath: null,
        healthPath: HEALTH_PATH,
        schedulerIntervalMs: 60000,
        reconcileIntervalMs: null,
        githubApp: false,
      },
    ]);
    expect(log.steps('http.request').map((line) => [line.level, line.method, line.path, line.status])).toEqual([
      ['info', 'POST', TELEGRAM_WEBHOOK_PATH, 200],
      ['info', 'POST', GITHUB_WEBHOOK_PATH, 404],
      ['info', 'GET', HEALTH_PATH, 200],
    ]);
    expect(log.steps('telegram.update')).toEqual([
      expect.objectContaining({ level: 'info', updateId: 7, kind: 'message', chatId: '1', chatType: 'private', fromId: '2', command: null }),
    ]);
    expect(log.steps('telegram.outcome')).toEqual([
      expect.objectContaining({ level: 'info', updateId: 7, handler: null, outcome: 'unhandled', code: null }),
    ]);
    expect(log.raw.join('\n')).not.toContain('ping');
    await started.stop('SIGTERM');
    expect(log.lines().slice(-2)).toEqual([
      { time: '2026-09-28T00:00:00.000Z', level: 'info', step: 'process.stopping', signal: 'SIGTERM' },
      { time: '2026-09-28T00:00:00.000Z', level: 'info', step: 'process.stopped', signal: 'SIGTERM' },
    ]);
    expect(log.raw.join('\n')).not.toMatch(/test-token|secret/);
  });

  it('без токена, секрета и интервала процесс не конфигурируется', () => {
    expect(() => readProcessConfig(env({ TELEGRAM_BOT_TOKEN: '' }), clock)).toThrow('TELEGRAM_BOT_TOKEN не задан');
    expect(() => readProcessConfig(env({ TELEGRAM_WEBHOOK_SECRET: '' }), clock)).toThrow('TELEGRAM_WEBHOOK_SECRET не задан');
    expect(() => readProcessConfig(env({ PORT: 'x' }), clock)).toThrow('PORT — целое число');
    expect(() => readProcessConfig(env({ SCHEDULER_INTERVAL_MS: '0' }), clock)).toThrow('SCHEDULER_INTERVAL_MS — целое число больше нуля');
  });

  it('путь и хост по умолчанию — webhook и все интерфейсы', () => {
    const config = readProcessConfig(env(), clock);
    expect(config.webhookPath).toBe(TELEGRAM_WEBHOOK_PATH);
    expect(config.host).toBe('0.0.0.0');
    expect(config.clock).toBe(clock);
    expect(config.githubWebhookSecret).toBeNull();
    expect(readProcessConfig(env({ GITHUB_WEBHOOK_SECRET: '  hook  ' }), clock).githubWebhookSecret).toBe('hook');
    expect(readProcessConfig(env({ GITHUB_TOKEN: 'ghp_secret', GH_TOKEN: 'github_pat_secret' }), clock).githubWebhookSecret).toBeNull();
  });

  it('сборка процесса одна: webhook, планировщик и движок вызываются из process.ts', () => {
    const callers = (needle: string, owner: string) =>
      filesIn('src').filter((path) => path !== owner && readFileSync(path, 'utf8').includes(needle));
    expect(callers('startTelegramWebhook(', 'src/telegram/webhook.ts')).toEqual(['src/process.ts']);
    expect(callers('createScheduler(', 'src/infrastructure/scheduler.ts')).toEqual(['src/process.ts']);
    expect(callers('startSchedulerLoop(', 'src/infrastructure/scheduler.ts')).toEqual(['src/process.ts']);
    expect(callers('createProgressEngine(', 'src/progress-engine.ts')).toEqual(['src/process.ts']);
    expect(callers('acceptGithubWebhookHttp(', 'src/github/webhook.ts')).toEqual(['src/process.ts']);
    const polling = filesIn('src').filter((path) => {
      const text = readFileSync(path, 'utf8');
      return text.includes('getUpdates') || text.includes('.start(');
    });
    expect(polling).toEqual([]);
  });
});
