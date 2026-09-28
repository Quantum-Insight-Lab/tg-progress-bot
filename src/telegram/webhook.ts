import { createServer, type Server } from 'node:http';
import { webhookCallback, type Bot } from 'grammy';

/** Путь приёма обновлений, если окружение его не задаёт. `setWebhook` — в развёртывании. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

export interface WebhookListenOptions {
  bot: Bot;
  /** Секрет заголовка `X-Telegram-Bot-Api-Secret-Token`. Пустой не принимается. */
  secretToken: string;
  path: string;
  port: number;
  host: string;
}

export interface WebhookServer {
  port: number;
  close(): Promise<void>;
}

function pathnameOf(url: string | undefined): string {
  if (url === undefined || url.length === 0) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const errorEvent = 'error';
    server.once(errorEvent, reject);
    server.listen(port, host, () => {
      server.off(errorEvent, reject);
      resolve();
    });
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('адрес webhook');
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Приём обновлений Bot API через webhook (B-2). Опрос обновлений не включается:
 * после этой настройки grammY не даёт запустить long polling.
 */
export async function startTelegramWebhook(options: WebhookListenOptions): Promise<WebhookServer> {
  if (options.secretToken.length === 0) throw new Error('секрет webhook пуст');
  if (!options.path.startsWith('/')) throw new Error('путь webhook');
  const handle = webhookCallback(options.bot, 'http', { secretToken: options.secretToken });
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || pathnameOf(req.url) !== options.path) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void handle(req, res).then(
      () => undefined,
      () => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end();
        }
      },
    );
  });
  await listen(server, options.port, options.host);
  return { port: boundPort(server), close: () => closeServer(server) };
}
