import { InlineKeyboard, type Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { GithubLoginActions } from '../domain/projects/github-login.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** Пункт настроек и заголовок сообщения с логином. */
export const GITHUB_LOGIN_HEADING = 'Логин GitHub';

export const GITHUB_LOGIN_ASK = [
  'Напишите логин GitHub двумя строками: первая — «Логин GitHub», вторая — сам логин.',
  'Шаг можно пропустить.',
  'Логин один на пользователя бота, не на каждый проект.',
].join('\n');

export const GITHUB_LOGIN_SKIP_LABEL = 'Пропустить';

export const GITHUB_LOGIN_SKIPPED = 'Шаг пропущен.';

export const GITHUB_LOGIN_TAKEN = 'Этот логин GitHub уже записан у другого человека.';

export const GITHUB_LOGIN_SELF = 'Логин GitHub меняет сам человек.';

/** Кнопка пропуска. Короткий callback, лимит Telegram — 64 байта. */
export const GITHUB_LOGIN_SKIP_DATA = 'gls';

export function githubLoginSavedReply(login: string): string {
  return `Логин GitHub записан: ${login}.`;
}

export function githubLoginSkipKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(GITHUB_LOGIN_SKIP_LABEL, GITHUB_LOGIN_SKIP_DATA);
}

/**
 * Вопрос человеку, у которого логин ещё не записан.
 * Уже записанный логин не спрашивается снова: он один на пользователя, не на проект.
 */
export async function deliverGithubLoginPrompt(
  person: { githubLogin: string | null } | null,
  send: (text: string, markup: InlineKeyboard) => Promise<unknown>,
): Promise<void> {
  if (person === null || person.githubLogin !== null) return;
  await send(GITHUB_LOGIN_ASK, githubLoginSkipKeyboard());
}

export interface GithubLoginMessage {
  login: string;
}

/** «Логин GitHub» и строка логина. Пустая строка — пропуск. Чужой текст командой не считается. */
export function parseGithubLoginMessage(text: string): GithubLoginMessage | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length !== 2) return null;
  if (lines[0]?.trim() !== GITHUB_LOGIN_HEADING) return null;
  const login = lines[1];
  if (login === undefined) return null;
  return { login: login.trim() };
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

function replyOf(error: unknown): string | null {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.GITHUB_LOGIN_DUPLICATE:
    case DOMAIN_ERROR.GITHUB_LOGIN_CHAT:
    case DOMAIN_ERROR.USER_NOT_FOUND:
      return null;
    case DOMAIN_ERROR.GITHUB_LOGIN_TAKEN:
      return GITHUB_LOGIN_TAKEN;
    case DOMAIN_ERROR.GITHUB_LOGIN_ACTOR:
      return GITHUB_LOGIN_SELF;
    default:
      throw error;
  }
}

function savedOrSkipped(login: string | null, skip: boolean): string {
  if (skip && login === null) return GITHUB_LOGIN_SKIPPED;
  if (login === null) return GITHUB_LOGIN_SKIPPED;
  return githubLoginSavedReply(login);
}

/**
 * Свой логин в личке. Вне лички молчит.
 * Пустая строка и кнопка пропуска не требуют логина.
 */
export async function replyToGithubLogin(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  login: string,
  actions: GithubLoginActions,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  const skip = login.trim().length === 0;
  try {
    const user = await actions.set({
      telegramUserId: String(from.id),
      chat: chatType,
      login: skip ? null : login.trim(),
      skip,
      idempotencyKey,
    });
    return savedOrSkipped(user.githubLogin, skip);
  } catch (error) {
    return replyOf(error);
  }
}

/** Сообщение «Логин GitHub» и кнопка «Пропустить» на единственном экземпляре grammY. */
export function attachGithubLogin(bot: Bot, actions: GithubLoginActions): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const parsed = parseGithubLoginMessage(text);
    if (parsed === null) {
      await next();
      return;
    }
    const reply = await replyToGithubLogin(ctx.chat?.type, ctx.from, String(ctx.update.update_id), parsed.login, actions);
    if (reply !== null) await ctx.reply(reply);
    await next();
  });

  bot.callbackQuery(GITHUB_LOGIN_SKIP_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const from = ctx.from;
    if (from.is_bot) return;
    const reply = await replyToGithubLogin(ctx.chat?.type, from, String(ctx.update.update_id), '', actions);
    if (reply !== null) await ctx.reply(reply);
  });
}
