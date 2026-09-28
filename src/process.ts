import type { Kysely } from 'kysely';
import type { InstallationRepositorySource } from './domain/github/repository.ts';
import { unconfiguredInstallationSource } from './domain/github/repository.ts';
import type { Clock } from './domain/shared/clock.ts';
import { createGithubAppClient, readGithubAppCredentials } from './github/client.ts';
import type { Database } from './infrastructure/database.ts';
import { createScheduler, startSchedulerLoop, type Scheduler } from './infrastructure/scheduler.ts';
import { createAccessGate } from './infrastructure/access.ts';
import { createChatBinding } from './infrastructure/chats.ts';
import { createExecutorTopics } from './infrastructure/executor-topic.ts';
import { createReportsTopics } from './infrastructure/reports-topic.ts';
import { createChatSchedule } from './infrastructure/schedule.ts';
import { createGithubLogin } from './infrastructure/github-login.ts';
import { createMembership } from './infrastructure/membership.ts';
import { createProjectCreation } from './infrastructure/projects.ts';
import { createProjectRepository } from './infrastructure/connect-repository.ts';
import { createInstallationRepositories } from './infrastructure/installation-repositories.ts';
import { createProjectSettings } from './infrastructure/settings.ts';
import { CANVAS_DESTINATION_TOPIC } from './domain/tasks/place-canvas.ts';
import { createCanvasPlacement, type CanvasHome } from './infrastructure/canvas.ts';
import { createTaskActions, createTaskMarkActions, createTaskReviewActions } from './infrastructure/tasks.ts';
import { createUserRegistration } from './infrastructure/users.ts';
import { createProgressEngine, type ProgressEngine } from './progress-engine.ts';
import { attachAccessGuard } from './telegram/access-guard.ts';
import { createTelegramBot, type TelegramBotInfo } from './telegram/bot.ts';
import { attachChatBinding, sendSupergroupRequest } from './telegram/chat-binding.ts';
import { attachExecutorTopic } from './telegram/executor-topic.ts';
import { attachReportsTopic } from './telegram/reports-topic.ts';
import { attachSchedule } from './telegram/schedule.ts';
import { attachProjectRepository, deliverProjectRepositoryStep } from './telegram/connect-repository.ts';
import { attachInstallationRepositories } from './telegram/installation-repositories.ts';
import { attachSettings } from './telegram/settings.ts';
import { attachGithubLogin, deliverGithubLoginPrompt } from './telegram/github-login.ts';
import { attachParticipants } from './telegram/members.ts';
import { attachNewProject } from './telegram/new-project.ts';
import { attachStartCommand } from './telegram/start.ts';
import { editCanvasMessage, sendCanvasMessage } from './telegram/canvas-message.ts';
import { renderCanvas } from './projections/canvas-message.ts';
import { tasksBlockParagraphs } from './projections/tasks-block.ts';
import { attachTaskCommand } from './telegram/task-command.ts';
import { attachTaskMark } from './telegram/task-mark.ts';
import { attachTaskReview } from './telegram/task-review.ts';
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
  /** Пул для команд бота. Без него обработчики не подключаются. */
  db?: Kysely<Database>;
  /** Задаётся в тестах, чтобы не вызывать `getMe`. Боевой вход поле не ставит. */
  botInfo?: TelegramBotInfo;
  /** Задаётся в тестах. Боевой вход читает GitHub App из окружения и не берёт личный токен. */
  installationSource?: InstallationRepositorySource;
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

function installationSourceOf(config: ProcessConfig): InstallationRepositorySource {
  if (config.installationSource !== undefined) return config.installationSource;
  const credentials = readGithubAppCredentials(process.env);
  if (credentials === null) return unconfiguredInstallationSource();
  return createGithubAppClient(credentials);
}

let running: RunningProcess | undefined;

/**
 * Один процесс backend: webhook Telegram, планировщик актов системы, Progress Engine.
 * Слот A-31 выставляет канвас на сегодня. Остальные слоты регистрируют свои issues.
 */
export async function startProcess(config: ProcessConfig): Promise<RunningProcess> {
  if (running !== undefined) throw new Error('процесс уже запущен');
  const bot = config.botInfo === undefined ? createTelegramBot(config.botToken) : createTelegramBot(config.botToken, config.botInfo);
  const deliverCanvas = {
    async send(home: CanvasHome): Promise<number> {
      return sendCanvasMessage(
        bot.api,
        { chatId: home.telegramChatId, messageThreadId: home.topicId },
        renderCanvas({
          projectName: home.projectName,
          canvasDate: home.canvasDate,
          sections: { tasks: tasksBlockParagraphs(home.tasks) },
        }),
      );
    },
    async edit(home: CanvasHome, messageId: number): Promise<void> {
      await editCanvasMessage(
        bot.api,
        { chatId: home.telegramChatId, messageThreadId: home.topicId },
        messageId,
        renderCanvas({
          projectName: home.projectName,
          canvasDate: home.canvasDate,
          sections: { tasks: tasksBlockParagraphs(home.tasks) },
        }),
      );
    },
  };
  let ensureToday: ((now: Date) => Promise<void>) | undefined;
  if (config.db !== undefined) {
    const canvas = createCanvasPlacement(config.db, config.clock);
    ensureToday = (now) => canvas.ensureToday(now, deliverCanvas.send);
    const binding = createChatBinding(config.db, config.clock);
    attachAccessGuard(bot, createAccessGate(config.db, config.clock));
    attachStartCommand(bot, createUserRegistration(config.db, config.clock));
    attachNewProject(bot, createProjectCreation(config.db, config.clock), (reply) => sendSupergroupRequest(reply, binding));
    const installation = createInstallationRepositories(config.db, installationSourceOf(config));
    const projectRepository = createProjectRepository(config.db, config.clock);
    attachChatBinding(bot, binding, (projectId, from, idempotencyKey, notify) =>
      deliverProjectRepositoryStep(from, projectId, idempotencyKey, projectRepository, installation, notify),
    );
    const githubLogin = createGithubLogin(config.db, config.clock);
    attachGithubLogin(bot, githubLogin);
    attachParticipants(bot, createMembership(config.db, config.clock), async (telegramUserId, send) => {
      await deliverGithubLoginPrompt(await githubLogin.find(telegramUserId), send);
    });
    attachExecutorTopic(bot, createExecutorTopics(config.db, config.clock), {
      posted(input) {
        return canvas.showForTopic({ ...input, causationId: null, send: deliverCanvas.send, edit: deliverCanvas.edit }).then(() => undefined);
      },
    });
    attachReportsTopic(bot, createReportsTopics(config.db, config.clock));
    attachSchedule(bot, createChatSchedule(config.db, config.clock));
    attachSettings(bot, createProjectSettings(config.db, config.clock));
    attachProjectRepository(bot, projectRepository, installation);
    attachInstallationRepositories(bot, installation);
    const redrawTaskCanvas = {
      redraw(input: { projectId: string; assigneeId: string; causationId: string }) {
        return canvas
          .show({
            projectId: input.projectId,
            assigneeId: input.assigneeId,
            destination: CANVAS_DESTINATION_TOPIC,
            causationId: input.causationId,
            send: deliverCanvas.send,
            edit: deliverCanvas.edit,
          })
          .then(() => undefined);
      },
    };
    attachTaskCommand(bot, createTaskActions(config.db, config.clock), redrawTaskCanvas);
    attachTaskMark(bot, createTaskMarkActions(config.db, config.clock), redrawTaskCanvas);
    attachTaskReview(bot, createTaskReviewActions(config.db, config.clock), redrawTaskCanvas);
  }
  const engine = createProgressEngine();
  const scheduler = createScheduler(config.clock);
  if (ensureToday !== undefined) scheduler.register('A-31', ensureToday);
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
