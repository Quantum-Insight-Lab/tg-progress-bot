import type { Bot } from 'grammy';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** `/rebuild проект | участник`. Имена могут содержать пробелы, их делит `|`. */
export function parseRebuildCommand(text: string): { projectName: string; memberName: string } | null {
  const match = /^\/rebuild(?![A-Za-z0-9_])(?:@[A-Za-z0-9_]+)?\s+([\s\S]+)$/.exec(text.trim());
  if (match === null) return null;
  const parts = (match[1] ?? '').split('|');
  if (parts.length !== 2) return null;
  const projectName = parts[0]?.trim() ?? '';
  const memberName = parts[1]?.trim() ?? '';
  if (projectName.length === 0 || memberName.length === 0) return null;
  return { projectName, memberName };
}

export const REBUILD_ROOT_ONLY = 'Канвас пересобирает корень.';
export const REBUILD_PRIVATE = 'Пересборка — в личке.';
export const REBUILD_MISSING = 'Сегодняшнего канваса нет.';
export const REBUILD_UNKNOWN = 'Проект или участник не найдены.';

function replyOf(error: DomainError): string | null {
  switch (error.code) {
    case DOMAIN_ERROR.REBUILD_ROOT:
      return REBUILD_ROOT_ONLY;
    case DOMAIN_ERROR.REBUILD_CHAT:
      return REBUILD_PRIVATE;
    case DOMAIN_ERROR.REBUILD_ABSENT:
    case DOMAIN_ERROR.REBUILD_DATE:
      return REBUILD_MISSING;
    case DOMAIN_ERROR.REBUILD_PROJECT:
    case DOMAIN_ERROR.REBUILD_MEMBER:
    case DOMAIN_ERROR.REBUILD_AMBIGUOUS:
      return REBUILD_UNKNOWN;
    default:
      return null;
  }
}

export interface RebuildActions {
  run(input: {
    telegramUserId: string;
    chat: string;
    projectName: string;
    memberName: string;
    idempotencyKey: string;
  }): Promise<void>;
}

/** Команда корня в личке. Чужому — отказ без данных канваса. */
export function attachRebuild(bot: Bot, actions: RebuildActions): void {
  bot.command('rebuild', async (ctx) => {
    const parsed = parseRebuildCommand(ctx.message?.text ?? '');
    if (parsed === null || ctx.from === undefined || ctx.from.is_bot) return;
    const chat = ctx.chat;
    try {
      await actions.run({
        telegramUserId: String(ctx.from.id),
        chat: chat?.type ?? '',
        projectName: parsed.projectName,
        memberName: parsed.memberName,
        idempotencyKey: String(ctx.update.update_id),
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      const text = replyOf(error);
      if (text !== null) await ctx.reply(text);
    }
  });
}
