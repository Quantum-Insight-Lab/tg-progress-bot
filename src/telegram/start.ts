import type { Bot } from 'grammy';
import type { UserRegistration } from '../domain/projects/user.ts';
import { traceHandler } from './update-log.ts';

/** Первый `/start`: человек — руководитель и может завести проект. */
export const START_REPLY_ROOT = 'Вы руководитель и можете завести проект.';

/** Поздний `/start`: доступ появится, когда корень добавит в проект. Данных проекта в тексте нет. */
export const START_REPLY_PENDING = 'Доступ появится, когда корень добавит вас в проект.';

export function startReply(isRoot: boolean): string {
  return isRoot ? START_REPLY_ROOT : START_REPLY_PENDING;
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string | undefined;
}

function displayName(account: TelegramAccount): string {
  const last = account.last_name;
  if (last === undefined || last.trim().length === 0) return account.first_name;
  return `${account.first_name} ${last}`;
}

/**
 * `/start` в личке регистрирует аккаунт и возвращает ответ.
 * В группе и канале молчит: регистрация — только личка.
 */
export async function replyToStart(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  registration: UserRegistration,
): Promise<string | null> {
  if (chatType !== 'private' || from === undefined || from.is_bot) return null;
  const result = await registration.registerOnStart({
    telegramUserId: String(from.id),
    name: displayName(from),
  });
  return startReply(result.user.isRoot);
}

/** Команда `/start` на единственном экземпляре grammY. */
export function attachStartCommand(bot: Bot, registration: UserRegistration): void {
  bot.command('start', async (ctx) => {
    traceHandler('start');
    const reply = await replyToStart(ctx.chat?.type, ctx.from, registration);
    if (reply === null) return;
    await ctx.reply(reply);
  });
}
