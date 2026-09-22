import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import { env } from "../config/index.js";
import { ingestGithubWebhook } from "../github/ingest.js";
import { logger } from "../infrastructure/logger.js";

export const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
export const GITHUB_WEBHOOK_PATH = "/github/webhook";

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export function createWebhookServer(deps: {
  bot: Bot;
  githubSecret: string | undefined;
  beforeTelegram?: () => Promise<void>;
}): Server {
  const telegram = webhookCallback(deps.bot, "http");
  return createServer((req, res) => {
    void route(req, res, deps, telegram).catch((error: unknown) => {
      logger.error("webhook.failed", { error: String(error) });
      if (!res.headersSent) {
        send(res, 500);
      }
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    bot: Bot;
    githubSecret: string | undefined;
    beforeTelegram?: () => Promise<void>;
  },
  telegram: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<void> {
  const path = req.url?.split("?")[0];
  if (req.method === "GET" && path === "/health") {
    send(res, 200, "ok");
    return;
  }
  if (req.method !== "POST") {
    send(res, 405);
    return;
  }
  if (path === TELEGRAM_WEBHOOK_PATH) {
    await deps.beforeTelegram?.();
    await telegram(req, res);
    return;
  }
  if (path === GITHUB_WEBHOOK_PATH) {
    await handleGithub(req, res, deps.githubSecret);
    return;
  }
  send(res, 404);
}

async function handleGithub(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string | undefined,
): Promise<void> {
  if (secret === undefined || secret.length === 0) {
    send(res, 503);
    return;
  }
  const result = await ingestGithubWebhook({
    secret,
    rawBody: await readBody(req),
    signatureHeader: header(req, "x-hub-signature-256"),
    deliveryId: header(req, "x-github-delivery"),
    eventName: header(req, "x-github-event"),
  });
  if (result.ok) {
    send(res, 200);
    return;
  }
  if (result.reason === "invalid_signature") {
    send(res, 401);
    return;
  }
  if (result.reason === "invalid_json" || result.reason === "missing_delivery") {
    send(res, 400);
    return;
  }
  send(res, 200);
}

export function listenWebhooks(deps: {
  bot: Bot;
  port?: number;
  githubSecret?: string | undefined;
  beforeTelegram?: () => Promise<void>;
}): Server {
  const port = deps.port ?? env().port;
  const server = createWebhookServer({
    bot: deps.bot,
    githubSecret: deps.githubSecret ?? env().githubWebhookSecret,
    ...(deps.beforeTelegram === undefined
      ? {}
      : { beforeTelegram: deps.beforeTelegram }),
  });
  server.listen(port);
  return server;
}
