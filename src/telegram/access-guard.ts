import type { Bot, Context } from 'grammy';
import type { AccessGate } from '../domain/projects/access.ts';
import { commandOf, traceGuard } from './update-log.ts';

/** Отказ постороннему. Имен, проектов и других данных в тексте нет. */
export const ACCESS_DENIED_REPLY = 'Нет доступа.';

const START_COMMAND = '/start';

function updateKind(ctx: Context): string {
  if (ctx.message !== undefined) return 'message';
  if (ctx.callbackQuery !== undefined) return 'callback_query';
  if (ctx.myChatMember !== undefined) return 'my_chat_member';
  return 'update';
}

/** Отказ вслух только там, где человек обратился к боту: команда или кнопка. */
function speaksDenial(ctx: Context): boolean {
  return commandOf(ctx) !== null || ctx.callbackQuery !== undefined;
}

/**
 * Единственный вход во все обработчики из `GUARDED_HANDLERS`.
 * `/start` проходит дальше: так человек становится известен боту.
 * Остальные обновления постороннего сюда не пускают.
 * «Нет доступа.» — на команду и на кнопку. Обычный текст в группе молчит:
 * бот-админ видит каждое сообщение.
 */
export function attachAccessGuard(bot: Bot, gate: AccessGate): void {
  bot.use(async (ctx, next) => {
    if (commandOf(ctx) === START_COMMAND) {
      traceGuard('allow', 'start');
      await next();
      return;
    }
    const from = ctx.from;
    if (from === undefined || from.is_bot) {
      traceGuard('allow', 'no_person');
      await next();
      return;
    }
    const decision = await gate.screen({
      telegramUserId: String(from.id),
      updateKind: updateKind(ctx),
      idempotencyKey: String(ctx.update.update_id),
    });
    traceGuard(decision, 'gate');
    if (decision === 'allow') {
      await next();
      return;
    }
    if (!speaksDenial(ctx)) return;
    if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery();
    if (ctx.chat !== undefined) await ctx.reply(ACCESS_DENIED_REPLY);
  });
}
