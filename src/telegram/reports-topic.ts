import { InlineKeyboard, type Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import {
  REPORTS_TOPIC_NAME,
  type ReportsBoard,
  type ReportsTopicActions,
} from '../domain/projects/reports-topic.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { afterReportsTopic } from './schedule.ts';

/** Строка настроек: командный топик. */
export const REPORTS_TOPIC_HEADING = 'Командный топик';

export const REPORTS_TOPIC_QUESTION = 'Есть ли уже командный топик?';

export const REPORTS_TOPIC_EMPTY = 'До привязки отчёты некуда отправлять.';

export const REPORTS_TOPIC_ACCESS = 'Нет доступа.';

export const REPORTS_TOPIC_ACTOR = 'Командный топик указывает руководитель.';

export const REPORTS_TOPIC_ROOT_ONLY = 'Командный топик меняет корень.';

export const REPORTS_TOPIC_NO_PROJECT = 'Такого проекта нет.';

export const REPORTS_TOPIC_AMBIGUOUS_PROJECT = 'Уточните проект: имя совпало у нескольких.';

export const REPORTS_TOPIC_BAD_ID = 'Номер топика — целое число больше нуля.';

export const REPORTS_TOPIC_ALREADY = 'Командный топик уже есть.';

export const REPORTS_TOPIC_COLLIDES = 'Командный топик не совпадает с топиками исполнителей.';

export const REPORTS_TOPIC_SET = 'Командный топик указан.';

export const REPORTS_TOPIC_CREATED = `Топик «${REPORTS_TOPIC_NAME}» создан.`;

const HAS_LABEL = 'Есть';

const CREATE_LABEL = 'Нет';

export interface ReportsChannel {
  create(telegramChatId: string, name: string): Promise<number>;
}

export interface ScreenReply {
  text: string;
  markup?: InlineKeyboard;
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export type ReportsRequest =
  | { kind: 'show'; projectName: string }
  | { kind: 'specify'; projectName: string; topicId: number }
  | { kind: 'invalid-topic' };

export function reportsTopicLine(topicId: number): string {
  return `Топик ${topicId}`;
}

/** Три строки, которыми указывают существующий командный топик. */
export function specifyReportsTemplate(projectName: string): string {
  return [REPORTS_TOPIC_HEADING, projectName, '<номер>'].join('\n');
}

export function renderReportsTopic(view: { projectName: string; bound: boolean; reportsTopicId: number | null }): string {
  if (!view.bound) return [REPORTS_TOPIC_HEADING, view.projectName, '', REPORTS_TOPIC_EMPTY].join('\n');
  const lines = [REPORTS_TOPIC_HEADING, view.projectName, ''];
  lines.push(view.reportsTopicId === null ? REPORTS_TOPIC_QUESTION : reportsTopicLine(view.reportsTopicId));
  return lines.join('\n');
}

/** «Командный топик» и имя проекта, либо те же две строки плюс номер. */
export function parseReportsTopicMessage(text: string): ReportsRequest | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== REPORTS_TOPIC_HEADING) return null;
  if (lines.length === 2) {
    const projectName = lines[1]?.trim() ?? '';
    if (projectName.length === 0) return null;
    return { kind: 'show', projectName };
  }
  if (lines.length !== 3) return null;
  const projectName = lines[1]?.trim() ?? '';
  const topicRaw = lines[2]?.trim() ?? '';
  if (projectName.length === 0) return null;
  if (!/^[1-9]\d*$/.test(topicRaw)) return { kind: 'invalid-topic' };
  const topicId = Number(topicRaw);
  if (!Number.isSafeInteger(topicId)) return { kind: 'invalid-topic' };
  return { kind: 'specify', projectName, topicId };
}

export function hasReportsCallbackData(projectId: string): string {
  return `ry:${projectId}`;
}

export function createReportsCallbackData(projectId: string): string {
  return `rn:${projectId}`;
}

export function parseReportsCallback(data: string): { action: 'has' | 'create'; projectId: string } | null {
  const match = /^(ry|rn):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(data);
  const kind = match?.[1];
  const projectId = match?.[2];
  if (kind === undefined || projectId === undefined) return null;
  return { action: kind === 'ry' ? 'has' : 'create', projectId };
}

export function reportsTopicKeyboard(view: ReportsBoard): InlineKeyboard | undefined {
  if (!view.bound || view.reportsTopicId !== null) return undefined;
  const keyboard = new InlineKeyboard();
  keyboard.text(HAS_LABEL, hasReportsCallbackData(view.project.id)).row();
  keyboard.text(CREATE_LABEL, createReportsCallbackData(view.project.id));
  return keyboard;
}

function screenOf(view: ReportsBoard): ScreenReply {
  const text = renderReportsTopic({
    projectName: view.project.name,
    bound: view.bound,
    reportsTopicId: view.reportsTopicId,
  });
  const markup = reportsTopicKeyboard(view);
  if (markup === undefined) return { text };
  return { text, markup };
}

function replyOf(error: unknown): ScreenReply | null {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.REPORTS_TOPIC_DUPLICATE:
    case DOMAIN_ERROR.REPORTS_TOPIC_CHAT:
      return null;
    case DOMAIN_ERROR.REPORTS_TOPIC_ACCESS:
      return { text: REPORTS_TOPIC_ACCESS };
    case DOMAIN_ERROR.REPORTS_TOPIC_ACTOR:
      return { text: REPORTS_TOPIC_ACTOR };
    case DOMAIN_ERROR.REPORTS_TOPIC_ROOT:
      return { text: REPORTS_TOPIC_ROOT_ONLY };
    case DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_MISSING:
      return { text: REPORTS_TOPIC_NO_PROJECT };
    case DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_AMBIGUOUS:
      return { text: REPORTS_TOPIC_AMBIGUOUS_PROJECT };
    case DOMAIN_ERROR.REPORTS_TOPIC_UNBOUND:
      return { text: REPORTS_TOPIC_EMPTY };
    case DOMAIN_ERROR.REPORTS_TOPIC_ID:
      return { text: REPORTS_TOPIC_BAD_ID };
    case DOMAIN_ERROR.REPORTS_TOPIC_ALREADY:
      return { text: REPORTS_TOPIC_ALREADY };
    case DOMAIN_ERROR.REPORTS_TOPIC_COLLIDES:
      return { text: REPORTS_TOPIC_COLLIDES };
    default:
      throw error;
  }
}

function inPrivate(chatType: string | undefined, from: TelegramAccount | undefined): chatType is typeof PRIVATE_CHAT {
  return chatType === PRIVATE_CHAT && from !== undefined && !from.is_bot;
}

/** Экран командного топика в личке. Вне лички молчит. */
export async function replyToReportsTopicMessage(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: ReportsRequest,
  idempotencyKey: string,
  actions: ReportsTopicActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  if (request.kind === 'invalid-topic') return { text: REPORTS_TOPIC_BAD_ID };
  try {
    if (request.kind === 'show') {
      const view = await actions.show({ telegramUserId: String(from.id), projectName: request.projectName, chat: chatType });
      return screenOf(view);
    }
    await actions.specify({
      telegramUserId: String(from.id),
      projectName: request.projectName,
      topicId: request.topicId,
      chat: chatType,
      idempotencyKey,
    });
    return { text: afterReportsTopic(REPORTS_TOPIC_SET) };
  } catch (error) {
    return replyOf(error);
  }
}

/** «Есть» — номер указывают следующим сообщением. Топик ещё не пишется. */
export async function replyToHasReportsTopic(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  actions: ReportsTopicActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const prompt = await actions.prompt({ telegramUserId: String(from.id), projectId, chat: chatType });
    return { text: specifyReportsTemplate(prompt.projectName) };
  } catch (error) {
    return replyOf(error);
  }
}

/** «Нет» — бот создаёт топик «Отчёты» в привязанной группе. */
export async function replyToCreateReportsTopic(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  idempotencyKey: string,
  actions: ReportsTopicActions,
  channel: ReportsChannel,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const plan = await actions.planCreate({
      telegramUserId: String(from.id),
      projectId,
      chat: chatType,
      idempotencyKey,
    });
    const topicId = await channel.create(plan.telegramChatId, plan.name);
    await actions.assign({
      telegramUserId: String(from.id),
      projectId,
      topicId,
      created: true,
      chat: chatType,
      idempotencyKey,
    });
    return { text: afterReportsTopic(REPORTS_TOPIC_CREATED) };
  } catch (error) {
    return replyOf(error);
  }
}

function send(ctx: { reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown> }, reply: ScreenReply): Promise<unknown> {
  if (reply.markup === undefined) return ctx.reply(reply.text);
  return ctx.reply(reply.text, { reply_markup: reply.markup });
}

function channelOf(bot: Bot): ReportsChannel {
  return {
    async create(telegramChatId, name) {
      const topic = await bot.api.createForumTopic(telegramChatId, name);
      return topic.message_thread_id;
    },
  };
}

/** «Командный топик» в личке: вопрос, номер существующего топика или создание «Отчёты». */
export function attachReportsTopic(bot: Bot, actions: ReportsTopicActions): void {
  const channel = channelOf(bot);
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const request = parseReportsTopicMessage(text);
    if (request === null) {
      await next();
      return;
    }
    const reply = await replyToReportsTopicMessage(ctx.chat?.type, ctx.from, request, String(ctx.update.update_id), actions);
    if (reply !== null) await send(ctx, reply);
    await next();
  });

  bot.callbackQuery(/^ry:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseReportsCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'has' || from.is_bot) return;
    const reply = await replyToHasReportsTopic(ctx.chat?.type, from, parsed.projectId, actions);
    if (reply !== null) await send(ctx, reply);
  });

  bot.callbackQuery(/^rn:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseReportsCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'create' || from.is_bot) return;
    const reply = await replyToCreateReportsTopic(ctx.chat?.type, from, parsed.projectId, String(ctx.update.update_id), actions, channel);
    if (reply !== null) await send(ctx, reply);
  });
}
