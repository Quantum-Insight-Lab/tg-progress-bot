import { InlineKeyboard, type Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { MembershipActions, ParticipantsView } from '../domain/projects/membership.ts';
import { withExecutorTopicStep } from '../projections/onboarding-next.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Строка настроек: участники проекта. */
export const PARTICIPANTS_HEADING = 'Участники';

export const PARTICIPANTS_NOT_IN_PROJECT = 'Ещё не в проекте:';

export const PARTICIPANTS_IN_PROJECT = 'В проекте:';

export const PARTICIPANTS_ACCESS = 'Нет доступа.';

export const PARTICIPANTS_ROOT_ONLY = 'Участников меняет корень.';

export const PARTICIPANTS_NO_PROJECT = 'Такого проекта нет.';

export const PARTICIPANTS_AMBIGUOUS = 'Уточните проект: имя совпало у нескольких.';

export const PARTICIPANTS_NOT_CANDIDATE = 'Этого человека нельзя добавить.';

export const PARTICIPANTS_ALREADY = 'Уже в проекте.';

export const PARTICIPANTS_ABSENT = 'В проекте этого человека нет.';

const BUTTON_TEXT_LIMIT = 64;

const ADD_PREFIX = 'Добавить: ';

const REMOVE_PREFIX = 'Удалить: ';

const CONFIRM_PREFIX = 'Подтвердить удаление: ';

export interface ParticipantsRequest {
  projectName: string;
}

export interface ScreenReply {
  text: string;
  markup?: InlineKeyboard;
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export function addedReply(name: string, projectName: string): string {
  return withExecutorTopicStep(`${name} добавлен как member.`, projectName);
}

export function isMemberAddedReply(text: string): boolean {
  return text.includes(' добавлен как member.');
}

export function removeConfirmText(name: string): string {
  return `Удалить из проекта: ${name}. Незакрытые задачи будут сняты.`;
}

export function removedReply(name: string): string {
  return `${name} удалён из проекта.`;
}

/** Экран состава: кто ещё не в проекте и кто уже в нём, с ролью этого проекта. */
export function renderParticipants(view: {
  projectName: string;
  candidates: readonly { name: string }[];
  members: readonly { name: string; role: string }[];
}): string {
  return [
    PARTICIPANTS_HEADING,
    view.projectName,
    '',
    PARTICIPANTS_NOT_IN_PROJECT,
    ...view.candidates.map((person) => person.name),
    '',
    PARTICIPANTS_IN_PROJECT,
    ...view.members.map((person) => `${person.name} — ${person.role}`),
  ].join('\n');
}

/** «Участники» и имя проекта. Чужой текст командой не считается. */
export function parseParticipantsMessage(text: string): ParticipantsRequest | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length !== 2) return null;
  if (lines[0]?.trim() !== PARTICIPANTS_HEADING) return null;
  const projectName = lines[1];
  if (projectName === undefined) return null;
  return { projectName: projectName.trim() };
}

function buttonLabel(prefix: string, name: string): string {
  const room = BUTTON_TEXT_LIMIT - prefix.length;
  if (room < 1) return prefix.slice(0, BUTTON_TEXT_LIMIT);
  const visible = name.length > room ? name.slice(0, room) : name;
  return `${prefix}${visible}`;
}

export function addCallbackData(projectId: string, telegramUserId: string): string {
  return `ma:${projectId}:${telegramUserId}`;
}

export function removeCallbackData(projectId: string, telegramUserId: string): string {
  return `md:${projectId}:${telegramUserId}`;
}

export function confirmCallbackData(projectId: string, telegramUserId: string): string {
  return `mc:${projectId}:${telegramUserId}`;
}

export function parseMemberCallback(
  data: string,
): { action: 'add' | 'remove' | 'confirm'; projectId: string; telegramUserId: string } | null {
  const match = /^(ma|md|mc):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d*)$/.exec(data);
  const kind = match?.[1];
  const projectId = match?.[2];
  const telegramUserId = match?.[3];
  if (kind === undefined || projectId === undefined || telegramUserId === undefined) return null;
  const action = kind === 'ma' ? 'add' : kind === 'md' ? 'remove' : 'confirm';
  return { action, projectId, telegramUserId };
}

export function participantsKeyboard(view: ParticipantsView): InlineKeyboard | undefined {
  const keyboard = new InlineKeyboard();
  let buttons = 0;
  for (const candidate of view.candidates) {
    keyboard.text(buttonLabel(ADD_PREFIX, candidate.name), addCallbackData(view.project.id, candidate.telegramUserId)).row();
    buttons += 1;
  }
  for (const member of view.members) {
    keyboard.text(buttonLabel(REMOVE_PREFIX, member.name), removeCallbackData(view.project.id, member.telegramUserId)).row();
    buttons += 1;
  }
  if (buttons === 0) return undefined;
  return keyboard;
}

export function removalKeyboard(projectId: string, telegramUserId: string, name: string): InlineKeyboard {
  return new InlineKeyboard().text(buttonLabel(CONFIRM_PREFIX, name), confirmCallbackData(projectId, telegramUserId));
}

function screenOf(view: ParticipantsView): ScreenReply {
  const text = renderParticipants({
    projectName: view.project.name,
    candidates: view.candidates,
    members: view.members,
  });
  const markup = participantsKeyboard(view);
  if (markup === undefined) return { text };
  return { text, markup };
}

function replyOf(error: unknown): ScreenReply | null {
  traceRefusal(error);
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.MEMBER_DUPLICATE:
    case DOMAIN_ERROR.MEMBER_CHAT:
      return null;
    case DOMAIN_ERROR.MEMBER_ACCESS:
      return { text: PARTICIPANTS_ACCESS };
    case DOMAIN_ERROR.MEMBER_ACTOR:
      return { text: PARTICIPANTS_ROOT_ONLY };
    case DOMAIN_ERROR.MEMBER_PROJECT_MISSING:
      return { text: PARTICIPANTS_NO_PROJECT };
    case DOMAIN_ERROR.MEMBER_PROJECT_AMBIGUOUS:
      return { text: PARTICIPANTS_AMBIGUOUS };
    case DOMAIN_ERROR.MEMBER_NOT_CANDIDATE:
      return { text: PARTICIPANTS_NOT_CANDIDATE };
    case DOMAIN_ERROR.MEMBER_ALREADY:
      return { text: PARTICIPANTS_ALREADY };
    case DOMAIN_ERROR.MEMBER_ABSENT:
      return { text: PARTICIPANTS_ABSENT };
    default:
      throw error;
  }
}

function inPrivate(chatType: string | undefined, from: TelegramAccount | undefined): chatType is typeof PRIVATE_CHAT {
  return chatType === PRIVATE_CHAT && from !== undefined && !from.is_bot;
}

/** Экран участников в личке корня. Вне лички молчит. */
export async function replyToParticipantsMessage(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: ParticipantsRequest,
  actions: MembershipActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const view = await actions.open({
      telegramUserId: String(from.id),
      projectName: request.projectName,
      chat: chatType,
    });
    return screenOf(view);
  } catch (error) {
    return replyOf(error);
  }
}

/** Один тап по человеку из списка добавляет его как `member`. */
export async function replyToAddMember(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  targetTelegramUserId: string,
  idempotencyKey: string,
  actions: MembershipActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const added = await actions.add({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      chat: chatType,
      idempotencyKey,
    });
    return { text: addedReply(added.name, added.projectName) };
  } catch (error) {
    return replyOf(error);
  }
}

/** Выбор участника просит подтверждение и ещё никого не удаляет. */
export async function replyToRemovalRequest(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  targetTelegramUserId: string,
  actions: MembershipActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const pending = await actions.describeRemoval({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      chat: chatType,
    });
    return {
      text: removeConfirmText(pending.name),
      markup: removalKeyboard(projectId, targetTelegramUserId, pending.name),
    };
  } catch (error) {
    return replyOf(error);
  }
}

/** Подтверждение снимает участника. Незакрытые задачи уходят в событие удаления. */
export async function replyToConfirmRemoval(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  targetTelegramUserId: string,
  idempotencyKey: string,
  actions: MembershipActions,
): Promise<ScreenReply | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const removed = await actions.remove({
      telegramUserId: String(from.id),
      projectId,
      targetTelegramUserId,
      chat: chatType,
      idempotencyKey,
    });
    return { text: removedReply(removed.name) };
  } catch (error) {
    return replyOf(error);
  }
}

function send(ctx: { reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown> }, reply: ScreenReply): Promise<unknown> {
  if (reply.markup === undefined) return ctx.reply(reply.text);
  return ctx.reply(reply.text, { reply_markup: reply.markup });
}

/** «Участники» в личке: список, добавление одним тапом, удаление после подтверждения. */
export function attachParticipants(
  bot: Bot,
  actions: MembershipActions,
  onAdded?: (telegramUserId: string, send: (text: string, markup: InlineKeyboard) => Promise<unknown>) => Promise<void>,
): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const request = parseParticipantsMessage(text);
    if (request === null) {
      await next();
      return;
    }
    traceHandler('participants');
    const reply = await replyToParticipantsMessage(ctx.chat?.type, ctx.from, request, actions);
    if (reply !== null) await send(ctx, reply);
    await next();
  });

  bot.callbackQuery(/^ma:/, async (ctx) => {
    traceHandler('participants');
    await ctx.answerCallbackQuery();
    const parsed = parseMemberCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'add' || from.is_bot) return;
    const reply = await replyToAddMember(ctx.chat?.type, from, parsed.projectId, parsed.telegramUserId, String(ctx.update.update_id), actions);
    if (reply !== null) await send(ctx, reply);
    if (onAdded !== undefined && reply !== null && isMemberAddedReply(reply.text)) {
      await onAdded(parsed.telegramUserId, (text, markup) => ctx.api.sendMessage(parsed.telegramUserId, text, { reply_markup: markup }));
    }
  });

  bot.callbackQuery(/^md:/, async (ctx) => {
    traceHandler('participants');
    await ctx.answerCallbackQuery();
    const parsed = parseMemberCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'remove' || from.is_bot) return;
    const reply = await replyToRemovalRequest(ctx.chat?.type, from, parsed.projectId, parsed.telegramUserId, actions);
    if (reply !== null) await send(ctx, reply);
  });

  bot.callbackQuery(/^mc:/, async (ctx) => {
    traceHandler('participants');
    await ctx.answerCallbackQuery();
    const parsed = parseMemberCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || parsed.action !== 'confirm' || from.is_bot) return;
    const reply = await replyToConfirmRemoval(
      ctx.chat?.type,
      from,
      parsed.projectId,
      parsed.telegramUserId,
      String(ctx.update.update_id),
      actions,
    );
    if (reply !== null) await send(ctx, reply);
  });
}
