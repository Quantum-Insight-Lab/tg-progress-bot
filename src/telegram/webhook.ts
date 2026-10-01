import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { webhookCallback, type Bot } from 'grammy';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';

/** Путь приёма обновлений, если окружение его не задаёт. `setWebhook` — в развёртывании. */
export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

/** Живость процесса на том же порту. Снаружи прокси его не отдаёт. Тело ответа пустое. */
export const HEALTH_PATH = '/healthz';

const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const STATUS_FAILED = 500;
const STATUS_UNAVAILABLE = 503;
const STEP_HTTP = 'http.request';

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
  /**
   * GET /healthz. `true` — 200, `false` или отказ — 503, тело пустое.
   * Нет функции — путь закрыт, как любой другой GET.
   */
  health?: () => Promise<boolean>;
  /** Строка на каждый запрос: метод, путь, код, длительность. Заголовки и тело не пишутся. */
  logger: Logger;
  clock: Clock;
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
    res.statusCode = STATUS_FAILED;
    res.end();
  }
}

function notFound(res: ServerResponse): void {
  res.statusCode = STATUS_NOT_FOUND;
  res.end();
}

export async function startTelegramWebhook(options: WebhookListenOptions): Promise<WebhookServer> {
  if (options.secretToken.length === 0) throw new Error('секрет webhook пуст');
  if (!options.path.startsWith('/')) throw new Error('путь webhook');
  const routes = options.routes ?? [];
  for (const route of routes) {
    if (!route.path.startsWith('/')) throw new Error('путь webhook');
    if (route.path === options.path) throw new Error('путь webhook занят');
  }
  if (options.health !== undefined && (options.path === HEALTH_PATH || routes.some((route) => route.path === HEALTH_PATH))) {
    throw new Error('путь webhook занят');
  }
  const handle = webhookCallback(options.bot, 'http', { secretToken: options.secretToken });
  const server = createServer((req, res) => {
    const startedAt = options.clock.now().getTime();
    const path = pathnameOf(req.url);
    const logEntry = (cause?: unknown): void => {
      const fields = {
        method: req.method ?? '',
        path,
        status: res.statusCode,
        durationMs: options.clock.now().getTime() - startedAt,
      };
      if (cause !== undefined || res.statusCode >= STATUS_FAILED) options.logger.error(STEP_HTTP, fields, cause);
      else options.logger.info(STEP_HTTP, fields);
    };
    const serve = (run: Promise<unknown>): void => {
      void run.then(
        () => {
          logEntry();
        },
        (error: unknown) => {
          fail(res);
          logEntry(error);
        },
      );
    };
    const health = options.health;
    if (req.method === 'GET' && path === HEALTH_PATH && health !== undefined) {
      serve(
        health().then(
          (ok) => {
            res.statusCode = ok ? STATUS_OK : STATUS_UNAVAILABLE;
            res.end();
          },
          (error: unknown) => {
            res.statusCode = STATUS_UNAVAILABLE;
            res.end();
            throw error;
          },
        ),
      );
      return;
    }
    if (req.method !== 'POST') {
      notFound(res);
      logEntry();
      return;
    }
    if (path === options.path) {
      serve(handle(req, res));
      return;
    }
    const route = routes.find((item) => item.path === path);
    if (route === undefined) {
      notFound(res);
      logEntry();
      return;
    }
    serve(route.handle(req, res));
  });
  await listen(server, options.port, options.host);
  return { port: boundPort(server), close: () => closeServer(server) };
}
