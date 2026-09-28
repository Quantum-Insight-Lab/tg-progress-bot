import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';

const clock: Clock = { now: () => new Date('2026-09-28T00:00:00.000Z') };

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
    await expect(startProcess(readProcessConfig(env(), clock))).rejects.toThrow('процесс уже запущен');
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
  });

  it('сборка процесса одна: webhook, планировщик и движок вызываются из process.ts', () => {
    const callers = (needle: string, owner: string) =>
      filesIn('src').filter((path) => path !== owner && readFileSync(path, 'utf8').includes(needle));
    expect(callers('startTelegramWebhook(', 'src/telegram/webhook.ts')).toEqual(['src/process.ts']);
    expect(callers('createScheduler(', 'src/infrastructure/scheduler.ts')).toEqual(['src/process.ts']);
    expect(callers('startSchedulerLoop(', 'src/infrastructure/scheduler.ts')).toEqual(['src/process.ts']);
    expect(callers('createProgressEngine(', 'src/progress-engine.ts')).toEqual(['src/process.ts']);
    const polling = filesIn('src').filter((path) => {
      const text = readFileSync(path, 'utf8');
      return text.includes('getUpdates') || text.includes('.start(');
    });
    expect(polling).toEqual([]);
  });
});
