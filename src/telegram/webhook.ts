import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { webhookCallback, type Bot } from 'grammy';

/** Путь приёма обновлений, если окружение его не задаёт. `setWebhook` — в развёртывании. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

/** Дополнительный POST-путь на том же порту. Адаптеры друг друга не импортируют. */
export interface WebhookRoute {
  path: string;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface WebhookListenOptions {
  bot: Bot;
  /** Секрет заголовка `X-Telegram-Bot-Api-Secret-Token`. Пустой не принимается. */
  secretToken: string;
  path: string;
  port: number;
  host: string;
  routes?: readonly WebhookRoute[];
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
function fail(res: ServerResponse): void {
  if (!res.writableEnded) {
    res.statusCode = 500;
    res.end();
  }
}

export async function startTelegramWebhook(options: WebhookListenOptions): Promise<WebhookServer> {
  if (options.secretToken.length === 0) throw new Error('секрет webhook пуст');
  if (!options.path.startsWith('/')) throw new Error('путь webhook');
  const routes = options.routes ?? [];
  for (const route of routes) {
    if (!route.path.startsWith('/')) throw new Error('путь webhook');
    if (route.path === options.path) throw new Error('путь webhook занят');
  }
  const handle = webhookCallback(options.bot, 'http', { secretToken: options.secretToken });
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const path = pathnameOf(req.url);
    if (path === options.path) {
      void handle(req, res).then(
        () => undefined,
        () => {
          fail(res);
        },
      );
      return;
    }
    const route = routes.find((item) => item.path === path);
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void route.handle(req, res).then(
      () => undefined,
      () => {
        fail(res);
      },
    );
  });
  await listen(server, options.port, options.host);
  return { port: boundPort(server), close: () => closeServer(server) };
}
