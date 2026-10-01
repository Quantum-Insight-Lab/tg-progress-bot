import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { HEALTH_PATH, startTelegramWebhook, TELEGRAM_WEBHOOK_PATH, type WebhookServer } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpExchange, httpStatus } from './http.ts';
import { captureLog } from './log-lines.ts';

const SECRET = 'webhook-secret';
const log = captureLog();
const clock = { now: () => new Date('2026-09-30T12:00:00.000Z') };

function update(id: number): string {
  return JSON.stringify({
    update_id: id,
    message: {
      message_id: id,
      date: 1700000000,
      chat: { id: 1, type: 'private' },
      from: { id: 2, is_bot: false, first_name: 'A' },
      text: 'ping',
    },
  });
}

describe('приём обновлений через webhook', () => {
  const seen: number[] = [];
  let server: WebhookServer;
  let startRejected: unknown;
  let bot: ReturnType<typeof createTelegramBot>;

  beforeAll(async () => {
    bot = createTelegramBot('test-token', testBotInfo);
    bot.use(async (ctx, next) => {
      seen.push(ctx.update.update_id);
      await next();
    });
    server = await startTelegramWebhook({
      bot,
      secretToken: SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      host: '127.0.0.1',
      logger: log.logger,
      clock,
    });
    try {
      await bot.start();
    } catch (error) {
      startRejected = error;
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it('POST с секретом доставляет обновление в тот же экземпляр и отвечает 200', async () => {
    const status = await httpStatus(server.port, 'POST', TELEGRAM_WEBHOOK_PATH, update(41), {
      'X-Telegram-Bot-Api-Secret-Token': SECRET,
      'content-length': String(Buffer.byteLength(update(41))),
    });
    expect(status).toBe(200);
    expect(seen).toContain(41);
  });

  it('чужой секрет не доставляет обновление', async () => {
    const before = seen.length;
    const status = await httpStatus(server.port, 'POST', TELEGRAM_WEBHOOK_PATH, update(42), {
      'X-Telegram-Bot-Api-Secret-Token': 'other',
    });
    expect(status).toBe(401);
    expect(await httpStatus(server.port, 'POST', TELEGRAM_WEBHOOK_PATH, update(44), {})).toBe(401);
    expect(seen.length).toBe(before);
    expect(seen).not.toContain(44);
  });

  it('другой путь и не-POST не являются входом', async () => {
    expect(await httpStatus(server.port, 'POST', '/other', update(43), { 'X-Telegram-Bot-Api-Secret-Token': SECRET })).toBe(404);
    expect(await httpStatus(server.port, 'GET', TELEGRAM_WEBHOOK_PATH, '', {})).toBe(404);
    expect(seen).not.toContain(43);
  });

  it('после webhook опрос getUpdates не запускается', () => {
    expect(startRejected).toBeInstanceOf(Error);
    expect((startRejected as Error).message).toMatch(/webhook/i);
  });

  it('без проверки здоровья GET /healthz закрыт', async () => {
    expect(await httpStatus(server.port, 'GET', HEALTH_PATH, '', {})).toBe(404);
    expect(await httpStatus(server.port, 'POST', HEALTH_PATH, '', {})).toBe(404);
  });

  it('пустой секрет не слушает', async () => {
    await expect(
      startTelegramWebhook({ bot, secretToken: '', path: TELEGRAM_WEBHOOK_PATH, port: 0, host: '127.0.0.1', logger: log.logger, clock }),
    ).rejects.toThrow('секрет webhook пуст');
  });

  it('INV-16 адрес здоровья отвечает кодом и пустым телом', async () => {
    const marker = 'проект-секрет';
    let healthy = true;
    const healthServer = await startTelegramWebhook({
      bot,
      secretToken: SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      port: 0,
      host: '127.0.0.1',
      logger: log.logger,
      clock,
      health: async () => {
        if (!healthy) throw new Error(`база недоступна ${marker}`);
        return true;
      },
    });
    try {
      expect(await httpExchange(healthServer.port, 'GET', HEALTH_PATH, '', {})).toEqual({ status: 200, body: '' });
      healthy = false;
      const down = await httpExchange(healthServer.port, 'GET', `${HEALTH_PATH}?x=1`, '', {});
      expect(down).toEqual({ status: 503, body: '' });
      expect(down.body).not.toContain(marker);
    } finally {
      await healthServer.close();
    }
  });

  it('путь webhook не занимает /healthz', async () => {
    await expect(
      startTelegramWebhook({
        bot,
        secretToken: SECRET,
        path: HEALTH_PATH,
        port: 0,
        host: '127.0.0.1',
        logger: log.logger,
        clock,
        health: async () => true,
      }),
    ).rejects.toThrow('путь webhook занят');
  });
});
