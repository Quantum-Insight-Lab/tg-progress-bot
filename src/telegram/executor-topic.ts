import { InlineKeyboard, type Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import { canvasHome, type AssignedTopic, type ExecutorTopicActions, type TopicBoard } from '../domain/projects/executor-topic.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { REPORTS_TOPIC_COLLIDES } from './reports-topic.ts';
import { FIRST_MESSAGE_TASK, renderFirstEmployeeMessage } from '../projections/first-employee-message.ts';

/** Строка настроек: топик исполнителя. */
export const EXECUTOR_TOPIC_HEADING = 'Топик исполнителя';

export const EXECUTOR_TOPIC_EMPTY = 'Пока супергруппа не привязана, топик исполнителя пуст.';

export const EXECUTOR_TOPIC_ACCESS = 'Нет доступа.';

export const EXECUTOR_TOPIC_ROOT_ONLY = 'Топик исполнителя указывает корень.';

export const EXECUTOR_TOPIC_NO_PROJECT = 'Такого проекта нет.';

export const EXECUTOR_TOPIC_AMBIGUOUS_PROJECT = 'Уточните проект: имя совпало у нескольких.';

export const EXECUTOR_TOPIC_ABSENT = 'В проекте этого человека нет.';

export const EXECUTOR_TOPIC_AMBIGUOUS_MEMBER = 'Уточните человека: имя совпало у нескольких.';

export const EXECUTOR_TOPIC_BAD_ID = 'Номер топика — целое число больше нуля.';

export const EXECUTOR_TOPIC_ALREADY = 'Топик уже есть.';

export const EXECUTOR_TOPIC_SET = 'Топик указан.';

export const EXECUTOR_TOPIC_CREATED = 'Топик создан.';

/** В топике та же строка, что и в личке: задача заводится здесь и появляется на канвасе. */
export const TASK_IN_TOPIC = FIRST_MESSAGE_TASK;

const BUTTON_TEXT_LIMIT = 64;

const HAS_PREFIX = 'Есть: ';

const CREATE_PREFIX = 'Нет: ';

export interface TopicChannel {
  create(telegramChatId: string, name: string): Promise<number>;
  tell(telegramChatId: string, topicId: number, text: string): Promise<void>;
  direct(telegramUserId: string, text: string): Promise<void>;
}

export interface ScreenReply {
  text: string;
  markup?: InlineKeyboard;
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export type TopicRequest =
  | { kind: 'show'; projectName: string }
  | { kind: 'specify'; projectName: string; memberName: string; topicId: number }
  | { kind: 'invalid-topic' };

export function topicQuestion(name: string): string {
  return `Есть ли у ${name} топик в группе?`;
}

export function topicSetLine(topicId: number): string {
  return `Топик ${topicId}`;
}

/** Четыре строки, которыми корень указывает существующий топик. */
export function specifyTemplate(projectName: string, memberName: string): string {
  return [EXECUTOR_TOPIC_HEADING, projectName, memberName, '<номер>'].join('\n');
}

export function renderExecutorTopics(view: {
  projectName: string;
  bound: boolean;
  members: readonly { name: string; role: string; topicId: number | null }[];
}): string {
  if (!view.bound) return [EXECUTOR_TOPIC_HEADING, view.projectName, '', EXECUTOR_TOPIC_EMPTY].join('\n');
  const lines = [EXECUTOR_TOPIC_HEADING, view.projectName, ''];
  for (const member of view.members) {
    lines.push(`${member.name} — ${member.role}`);
    lines.push(member.topicId === null ? topicQuestion(member.name) : topicSetLine(member.topicId));
  }
  return lines.join('\n');
}

/** «Топик исполнителя» и имя проекта, либо те же две строки плюс имя и номер. */
export function parseExecutorTopicMessage(text: string): TopicRequest | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== EXECUTOR_TOPIC_HEADING) return null;
  if (lines.length === 2) {
    const projectName = lines[1]?.trim() ?? '';
    if (projectName.length === 0) return null;
    return { kind: 'show', projectName };
  }
  if (lines.length !== 4) return null;
  const projectName = lines[1]?.trim() ?? '';
  const memberName = lines[2]?.trim() ?? '';
  const topicRaw = lines[3]?.trim() ?? '';
  if (projectName.length === 0 || memberName.length === 0) return null;
  if (!/^[1-9]\d*$/.test(topicRaw)) return { kind: 'invalid-topic' };
  const topicId = Number(topicRaw);
  if (!Number.isSafeInteger(topicId)) return { kind: 'invalid-topic' };
  return { kind: 'specify', projectName, memberName, topicId };
}

function buttonLabel(prefix: string, name: string): string {
  const room = BUTTON_TEXT_LIMIT - prefix.length;
  if (room < 1) return prefix.slice(0, BUTTON_TEXT_LIMIT);
  const visible = name.length > room ? name.slice(0, room) : name;
  return `${prefix}${visible}`;
}

export function hasTopicCallbackData(projectId: string, telegramUserId: string): string {
  return `ty:${projectId}:${telegramUserId}`;
}

export function createTopicCallbackData(projectId: string, telegramUserId: string): string {
  return `tn:${projectId}:${telegramUserId}`;
}

export function parseTopicCallback(data: string): { action: 'has' | 'create'; projectId: string; telegramUserId: string } | null {
  const match = /^(ty|tn):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d*)$/.exec(data);
  const kind = match?.[1];
  const projectId = match?.[2];
  const telegramUserId = match?.[3];
  if (kind === undefined || projectId === undefined || telegramUserId === undefined) return null;
  return { action: kind === 'ty' ? 'has' : 'create', projectId, telegramUserId };
}

export function executorTopicKeyboard(view: TopicBoard): InlineKeyboard | undefined {
  if (!view.bound) return undefined;
  const keyboard = new InlineKeyboard();
  let buttons = 0;
  for (const member of view.members) {
    if (member.topicId !== null) continue;
    keyboard.text(buttonLabel(HAS_PREFIX, member.name), hasTopicCallbackData(view.project.id, member.telegramUserId)).row();
    keyboard.text(buttonLabel(CREATE_PREFIX, member.name), createTopicCallbackData(view.project.id, member.telegramUserId)).row();
    buttons += 1;
  }
  if (buttons === 0) return undefined;
  return keyboard;
}

function screenOf(view: TopicBoard): ScreenReply {
  const text = renderExecutorTopics({
    projectName: view.project.name,
    bound: view.bound,
    members: view.members,
  });
  const markup = executorTopicKeyboard(view);
  if (markup === undefined) return { text };
  return { text, markup };
}

function replyOf(error: unknown): ScreenReply | null {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.TOPIC_DUPLICATE:
    case DOMAIN_ERROR.TOPIC_CHAT:
      return null;
    case DOMAIN_ERROR.TOPIC_ACCESS:
      return { text: EXECUTOR_TOPIC_ACCESS };
    case DOMAIN_ERROR.TOPIC_ACTOR:
      return { text: EXECUTOR_TOPIC_ROOT_ONLY };
    case DOMAIN_ERROR.TOPIC_PROJECT_MISSING:
      return { text: EXECUTOR_TOPIC_NO_PROJECT };
    case DOMAIN_ERROR.TOPIC_PROJECT_AMBIGUOUS:
      return { text: EXECUTOR_TOPIC_AMBIGUOUS_PROJECT };
    case DOMAIN_ERROR.TOPIC_UNBOUND:
      return { text: EXECUTOR_TOPIC_EMPTY };
    case DOMAIN_ERROR.TOPIC_ABSENT:
      return { text: EXECUTOR_TOPIC_ABSENT };
    case DOMAIN_ERROR.TOPIC_AMBIGUOUS:
      return { text: EXECUTOR_TOPIC_AMBIGUOUS_MEMBER };
    case DOMAIN_ERROR.TOPIC_ID:
      return { text: EXECUTOR_TOPIC_BAD_ID };
    case DOMAIN_ERROR.TOPIC_ALREADY:
      return { text: EXECUTOR_TOPIC_ALREADY };
    case DOMAIN_ERROR.REPORTS_TOPIC_COLLIDES:
      return { text: REPORTS_TOPIC_COLLIDES };
    default:
      throw error;
  }
}

function inPrivate(chatType: string | undefined, from: TelegramAccount | undefined): chatType is typeof PRIVATE_CHAT {
  return chatType === PRIVATE_CHAT && from !== undefined && !from.is_bot;
}

/** Один текст сотруднику в личку и тем же текстом в его топик. Канвас этим сообщением не становится. */
async function deliverFirstMessage(channel: TopicChannel, assigned: AssignedTopic): Promise<void> {
  const home = canvasHome(assigned.home.telegramChatId, assigned.home.topicId);
  const text = renderFirstEmployeeMessage({
    projectName: assigned.projectName,
    topicId: home.topicId,
    githubLogin: assigned.githubLogin,
  });
  await channel.direct(assigned.telegramUserId, text);
  await channel.tell(home.telegramChatId, home.topicId, text);
}

/** Экран топиков в личке корня. Вне лички молчит. */
export async function replyToExecutorTopicMessage(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: TopicRequest,
  idempotencyKey: string,
  actions: ExecutorTopicActions,
  channel: TopicChannel,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  if (request.kind === 'invalid-topic') return { text: EXECUTOR_TOPIC_BAD_ID };
  try {
    if (request.kind === 'show') {
      const view = await actions.show({ telegramUserId: String(from.id), projectName: request.projectName, chat: chatType });
      return screenOf(view);
    }
    const assigned = await actions.specify({
      telegramUserId: String(from.id),
      projectName: request.projectName,
      memberName: request.memberName,
      topicId: request.topicId,
      chat: chatType,
      idempotencyKey,
    });
    await deliverFirstMessage(channel, assigned);
    return { text: EXECUTOR_TOPIC_SET };
  } catch (error) {
    return replyOf(error);
  }
}

/** «Есть» — корень указывает номер следующим сообщением. Топик ещё не пишется. */
export async function replyToHasTopic(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  targetTelegramUserId: string,
  actions: ExecutorTopicActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const prompt = await actions.prompt({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      chat: chatType,
    });
    return { text: specifyTemplate(prompt.projectName, prompt.memberName) };
  } catch (error) {
    return replyOf(error);
  }
}

/** «Нет» — бот создаёт топик с именем человека и шлёт первое сообщение в личку и в топик. */
export async function replyToCreateTopic(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  targetTelegramUserId: string,
  idempotencyKey: string,
  actions: ExecutorTopicActions,
  channel: TopicChannel,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const plan = await actions.planCreate({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      chat: chatType,
      idempotencyKey,
    });
    const topicId = await channel.create(plan.telegramChatId, plan.name);
    const assigned = await actions.assign({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      topicId,
      created: true,
      chat: chatType,
      idempotencyKey,
    });
    await deliverFirstMessage(channel, assigned);
    return { text: EXECUTOR_TOPIC_CREATED };
  } catch (error) {
    return replyOf(error);
  }
}

function send(ctx: { reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown> }, reply: ScreenReply): Promise<unknown> {
  if (reply.markup === undefined) return ctx.reply(reply.text);
  return ctx.reply(reply.text, { reply_markup: reply.markup });
}

function channelOf(bot: Bot): TopicChannel {
  return {
    async create(telegramChatId, name) {
      const topic = await bot.api.createForumTopic(telegramChatId, name);
      return topic.message_thread_id;
    },
    async tell(telegramChatId, topicId, text) {
      await bot.api.sendMessage(telegramChatId, text, { message_thread_id: topicId });
    },
    async direct(telegramUserId, text) {
      await bot.api.sendMessage(telegramUserId, text);
    },
  };
}

/** «Топик исполнителя» в личке: вопрос, номер существующего топика или создание с именем человека. */
export function attachExecutorTopic(bot: Bot, actions: ExecutorTopicActions): void {
  const channel = channelOf(bot);
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const request = parseExecutorTopicMessage(text);
    if (request === null) {
      await next();
      return;
    }
    const reply = await replyToExecutorTopicMessage(ctx.chat?.type, ctx.from, request, String(ctx.update.update_id), actions, channel);
    if (reply !== null) await send(ctx, reply);
    await next();
  });

  bot.callbackQuery(/^ty:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseTopicCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'has' || from.is_bot) return;
    const reply = await replyToHasTopic(ctx.chat?.type, from, parsed.projectId, parsed.telegramUserId, actions);
    if (reply !== null) await send(ctx, reply);
  });

  bot.callbackQuery(/^tn:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseTopicCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'create' || from.is_bot) return;
    const reply = await replyToCreateTopic(
      ctx.chat?.type,
      from,
      parsed.projectId,
      parsed.telegramUserId,
      String(ctx.update.update_id),
      actions,
      channel,
    );
    if (reply !== null) await send(ctx, reply);
  });
}
