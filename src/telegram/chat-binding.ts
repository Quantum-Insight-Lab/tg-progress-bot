import { InlineKeyboard, type Bot } from 'grammy';
import { assessSupergroup, type ChatBinding, type ChatKind, type SupergroupOffer } from '../domain/projects/chat.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** Бот просит супергруппу с темами и права администратора. */
export const SUPERGROUP_REQUEST =
  'Добавьте бота в супергруппу с темами. Нужны права администратора: сообщения и управление темами.';

export const SUPERGROUP_BOUND = 'Супергруппа привязана.';

export const SUPERGROUP_SHARED = 'Проект сел в ту же супергруппу.';

export const SUPERGROUP_CONFIRM_REFUSAL = 'Подтверждает супергруппу руководитель.';

export const SUPERGROUP_ALREADY = 'У проекта уже есть супергруппа.';

const BUTTON_TEXT_LIMIT = 64;

interface TelegramChatShape {
  id: number;
  type: string;
  is_forum?: boolean | undefined;
}

interface TelegramMemberShape {
  status: string;
  can_post_messages?: boolean;
  can_manage_topics?: boolean;
}

function kindOf(type: string): ChatKind {
  if (type === 'supergroup' || type === 'group' || type === 'channel' || type === 'private') return type;
  return 'group';
}

function rightsOf(member: TelegramMemberShape): { post: boolean; topics: boolean } {
  if (member.status === 'creator') return { post: true, topics: true };
  if (member.status !== 'administrator') return { post: false, topics: false };
  return {
    post: member.can_post_messages !== false,
    topics: member.can_manage_topics === true,
  };
}

/** Чат Telegram → предложение привязки. Топик отдельным чатом не приходит. */
export function offerFromChat(chat: TelegramChatShape, member: TelegramMemberShape): SupergroupOffer {
  const rights = rightsOf(member);
  return {
    telegramChatId: String(chat.id),
    kind: kindOf(chat.type),
    forum: chat.is_forum === true,
    canPostMessages: rights.post,
    canManageTopics: rights.topics,
  };
}

export function bindCallbackData(projectId: string, telegramChatId: string): string {
  return `b:${projectId}:${telegramChatId}`;
}

export function parseBindCallback(data: string): { projectId: string; telegramChatId: string } | null {
  const match = /^b:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(-[1-9]\d*)$/.exec(data);
  const projectId = match?.[1];
  const telegramChatId = match?.[2];
  if (projectId === undefined || telegramChatId === undefined) return null;
  return { projectId, telegramChatId };
}

function buttonLabel(name: string): string {
  const prefix = 'Подтвердить: ';
  const room = BUTTON_TEXT_LIMIT - prefix.length;
  const visible = name.length > room ? name.slice(0, room) : name;
  return `${prefix}${visible}`;
}

async function confirmKeyboard(binding: ChatBinding, telegramChatId: string | null): Promise<InlineKeyboard | undefined> {
  const unbound = await binding.unboundProjects();
  if (unbound.length === 0) return undefined;
  const chats = telegramChatId === null ? await binding.knownChats() : [{ telegramChatId }];
  if (chats.length === 0) return undefined;
  const keyboard = new InlineKeyboard();
  for (const project of unbound) {
    for (const chat of chats) {
      keyboard.text(buttonLabel(project.name), bindCallbackData(project.id, chat.telegramChatId)).row();
    }
  }
  return keyboard;
}

export type SupergroupReply = (text: string, markup?: InlineKeyboard) => Promise<unknown>;

/** После «Новый проект»: просьба привязать супергруппу. Если группа уже есть — один тап сажает проект в неё. */
export async function sendSupergroupRequest(reply: SupergroupReply, binding: ChatBinding): Promise<void> {
  const unbound = await binding.unboundProjects();
  if (unbound.length === 0) return;
  const markup = await confirmKeyboard(binding, null);
  if (markup === undefined) await reply(SUPERGROUP_REQUEST);
  else await reply(SUPERGROUP_REQUEST, markup);
}

function boundReply(shared: boolean): string {
  return shared ? SUPERGROUP_SHARED : SUPERGROUP_BOUND;
}

async function refuse(error: DomainError, notify: (text: string) => Promise<unknown>): Promise<void> {
  if (error.code === DOMAIN_ERROR.CHAT_DUPLICATE || error.code === DOMAIN_ERROR.CHAT_PROJECT_MISSING) return;
  if (error.code === DOMAIN_ERROR.CHAT_BIND_ACTOR) {
    await notify(SUPERGROUP_CONFIRM_REFUSAL);
    return;
  }
  if (error.code === DOMAIN_ERROR.CHAT_ALREADY_BOUND) {
    await notify(SUPERGROUP_ALREADY);
    return;
  }
  if (
    error.code === DOMAIN_ERROR.CHAT_IS_TOPIC ||
    error.code === DOMAIN_ERROR.CHAT_NOT_SUPERGROUP ||
    error.code === DOMAIN_ERROR.CHAT_ADMIN_RIGHTS
  ) {
    await notify(SUPERGROUP_REQUEST);
    return;
  }
  throw error;
}

/** Добавление бота в группу и один тап подтверждения. В саму группу бот не пишет. */
export function attachChatBinding(bot: Bot, binding: ChatBinding): void {
  bot.use(async (ctx, next) => {
    const update = ctx.myChatMember;
    if (update === undefined) {
      await next();
      return;
    }
    const status = update.new_chat_member.status;
    if (status === 'left' || status === 'kicked') return;
    const chatType = update.chat.type;
    if (chatType !== 'supergroup' && chatType !== 'group' && chatType !== 'channel') return;
    const rootId = await binding.rootTelegramId();
    if (rootId === null) return;
    const offer = offerFromChat(update.chat, update.new_chat_member);
    const rejected = assessSupergroup(offer);
    const notify = (text: string, markup?: InlineKeyboard): Promise<unknown> => {
      if (markup === undefined) return ctx.api.sendMessage(rootId, text);
      return ctx.api.sendMessage(rootId, text, { reply_markup: markup });
    };
    if (rejected !== null) {
      const unbound = await binding.unboundProjects();
      if (unbound.length === 0) return;
      await notify(SUPERGROUP_REQUEST);
      return;
    }
    const unbound = await binding.unboundProjects();
    if (unbound.length === 0) return;
    const markup = await confirmKeyboard(binding, offer.telegramChatId);
    await notify(SUPERGROUP_REQUEST, markup);
  });

  bot.callbackQuery(/^b:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseBindCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || from === undefined || from.is_bot) return;
    const notify = (text: string): Promise<unknown> => ctx.api.sendMessage(from.id, text);
    let offer: SupergroupOffer;
    try {
      const chat = await ctx.api.getChat(parsed.telegramChatId);
      const member = await ctx.api.getChatMember(parsed.telegramChatId, ctx.me.id);
      offer = offerFromChat(chat, member);
    } catch (error) {
      if (error instanceof DomainError) {
        await refuse(error, notify);
        return;
      }
      throw error;
    }
    try {
      const result = await binding.confirm({
        telegramUserId: String(from.id),
        projectId: parsed.projectId,
        offer,
        idempotencyKey: String(ctx.update.update_id),
      });
      if (result.status === 'unchanged') return;
      await notify(boundReply(result.shared));
    } catch (error) {
      if (error instanceof DomainError) {
        await refuse(error, notify);
        return;
      }
      throw error;
    }
  });
}
