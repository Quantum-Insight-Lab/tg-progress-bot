import type { Kysely } from 'kysely';
import type { Clock } from './domain/shared/clock.ts';
import type { Database } from './infrastructure/database.ts';
import { createScheduler, startSchedulerLoop, type Scheduler } from './infrastructure/scheduler.ts';
import { createChatBinding } from './infrastructure/chats.ts';
import { createMembership } from './infrastructure/membership.ts';
import { createProjectCreation } from './infrastructure/projects.ts';
import { createUserRegistration } from './infrastructure/users.ts';
import { createProgressEngine, type ProgressEngine } from './progress-engine.ts';
import { createTelegramBot, type TelegramBotInfo } from './telegram/bot.ts';
import { attachChatBinding, sendSupergroupRequest } from './telegram/chat-binding.ts';
import { attachParticipants } from './telegram/members.ts';
import { attachNewProject } from './telegram/new-project.ts';
import { attachStartCommand } from './telegram/start.ts';
import { startTelegramWebhook, TELEGRAM_WEBHOOK_PATH, type WebhookServer } from './telegram/webhook.ts';

const DEFAULT_HOST = '0.0.0.0';

export interface ProcessConfig {
  botToken: string;
  webhookSecret: string;
  port: number;
  host: string;
  schedulerIntervalMs: number;
  webhookPath: string;
  clock: Clock;
  /** Пул для `/start`. Без него команда не подключается. */
  db?: Kysely<Database>;
  /** Задаётся в тестах, чтобы не вызывать `getMe`. Боевой вход поле не ставит. */
  botInfo?: TelegramBotInfo;
}

export interface RunningProcess {
  bot: ReturnType<typeof createTelegramBot>;
  engine: ProgressEngine;
  scheduler: Scheduler;
  port: number;
  stop(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} не задан`);
  return value;
}

function whole(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} — целое число`);
  return Number(raw);
}

/** Конфиг одного процесса из окружения. Секреты в код не записываются. */
export function readProcessConfig(env: NodeJS.ProcessEnv, clock: Clock): ProcessConfig {
  const schedulerIntervalMs = whole(env, 'SCHEDULER_INTERVAL_MS');
  if (schedulerIntervalMs < 1) throw new Error('SCHEDULER_INTERVAL_MS — целое число больше нуля');
  const webhookPath = env.TELEGRAM_WEBHOOK_PATH;
  const host = env.HOST;
  return {
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    webhookSecret: required(env, 'TELEGRAM_WEBHOOK_SECRET'),
    port: whole(env, 'PORT'),
    host: host === undefined || host.length === 0 ? DEFAULT_HOST : host,
    schedulerIntervalMs,
    webhookPath: webhookPath === undefined || webhookPath.length === 0 ? TELEGRAM_WEBHOOK_PATH : webhookPath,
    clock,
  };
}

let running: RunningProcess | undefined;

/**
 * Один процесс backend: webhook Telegram, планировщик актов системы, Progress Engine.
 * Слоты планировщика пустые — акт регистрирует своя issue.
 */
export async function startProcess(config: ProcessConfig): Promise<RunningProcess> {
  if (running !== undefined) throw new Error('процесс уже запущен');
  const bot = config.botInfo === undefined ? createTelegramBot(config.botToken) : createTelegramBot(config.botToken, config.botInfo);
  if (config.db !== undefined) {
    const binding = createChatBinding(config.db, config.clock);
    attachStartCommand(bot, createUserRegistration(config.db, config.clock));
    attachNewProject(bot, createProjectCreation(config.db, config.clock), (reply) => sendSupergroupRequest(reply, binding));
    attachChatBinding(bot, binding);
    attachParticipants(bot, createMembership(config.db, config.clock));
  }
  const engine = createProgressEngine();
  const scheduler = createScheduler(config.clock);
  const webhook: WebhookServer = await startTelegramWebhook({
    bot,
    secretToken: config.webhookSecret,
    path: config.webhookPath,
    port: config.port,
    host: config.host,
  });
  const loop = startSchedulerLoop(scheduler, config.schedulerIntervalMs);
  let stopped = false;
  running = {
    bot,
    engine,
    scheduler,
    port: webhook.port,
    async stop() {
      if (stopped) return;
      stopped = true;
      loop.stop();
      await webhook.close();
    },
  };
  return running;
}
