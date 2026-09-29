import type { Bot, Context } from 'grammy';
import type { AccessGate } from '../domain/projects/access.ts';

/** Отказ постороннему. Имен, проектов и других данных в тексте нет. */
export const ACCESS_DENIED_REPLY = 'Нет доступа.';

/**
 * Обработчики, которые стоят за единственным guard.
 * Новый обработчик добавляется сюда и подключается в процессе после guard.
 */
export const GUARDED_HANDLERS = ['start', 'new-project', 'chat-binding', 'participants', 'executor-topic', 'github-login', 'reports-topic', 'schedule', 'settings', 'installation-repositories', 'project-repository', 'task', 'report'] as const;

export type GuardedHandler = (typeof GUARDED_HANDLERS)[number];

function isStartCommand(ctx: Context): boolean {
  const message = ctx.message;
  if (message === undefined || !('text' in message) || message.text === undefined) return false;
  if (!('entities' in message) || message.entities === undefined) return false;
  const entity = message.entities[0];
  if (entity === undefined || entity.type !== 'bot_command' || entity.offset !== 0) return false;
  const token = message.text.slice(entity.offset, entity.offset + entity.length);
  const name = token.split('@')[0];
  return name === '/start';
}

function updateKind(ctx: Context): string {
  if (ctx.message !== undefined) return 'message';
  if (ctx.callbackQuery !== undefined) return 'callback_query';
  if (ctx.myChatMember !== undefined) return 'my_chat_member';
  return 'update';
}

/**
 * Единственный вход во все обработчики.
 * `/start` проходит дальше: так человек становится известен боту.
 * Остальные обновления постороннего сюда не пускают и отвечают отказом.
 */
export function attachAccessGuard(bot: Bot, gate: AccessGate): void {
  bot.use(async (ctx, next) => {
    if (isStartCommand(ctx)) {
      await next();
      return;
    }
    const from = ctx.from;
    if (from === undefined || from.is_bot) {
      await next();
      return;
    }
    const decision = await gate.screen({
      telegramUserId: String(from.id),
      updateKind: updateKind(ctx),
      idempotencyKey: String(ctx.update.update_id),
    });
    if (decision === 'allow') {
      await next();
      return;
    }
    if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery();
    if (ctx.chat !== undefined) await ctx.reply(ACCESS_DENIED_REPLY);
  });
}
