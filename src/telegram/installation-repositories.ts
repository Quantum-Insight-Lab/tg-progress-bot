import type { Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { InstallationRepositories, Repository } from '../domain/github/repository.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Заголовок списка репозиториев установки. */
export const REPOSITORIES_HEADING = 'Репозитории';

export const REPOSITORIES_EMPTY = 'Установка GitHub App не дала репозиториев.';

export const REPOSITORIES_ACCESS = 'Репозитории установки показывает руководителю.';

export const REPOSITORIES_APP = 'Доступ к GitHub — через GitHub App, не через личный токен.';

export const REPOSITORIES_UNAVAILABLE = 'Репозитории установки GitHub App сейчас не прочитаны.';

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

/** Одно слово «Репозитории». Чужой текст командой не считается. */
export function parseRepositoriesMessage(text: string): boolean {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  return lines.length === 1 && lines[0]?.trim() === REPOSITORIES_HEADING;
}

/** Список `owner/name` в порядке, который отдал домен. Пустая установка — отдельная фраза. */
export function renderRepositories(repositories: readonly Repository[]): string {
  if (repositories.length === 0) return REPOSITORIES_EMPTY;
  const lines = [REPOSITORIES_HEADING];
  for (const repository of repositories) lines.push(`${repository.owner}/${repository.name}`);
  return lines.join('\n');
}

function replyOf(error: unknown): string | null {
  traceRefusal(error);
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.REPOSITORY_CHAT:
      return null;
    case DOMAIN_ERROR.REPOSITORY_ACCESS:
      return REPOSITORIES_ACCESS;
    case DOMAIN_ERROR.REPOSITORY_APP:
      return REPOSITORIES_APP;
    case DOMAIN_ERROR.REPOSITORY_UNAVAILABLE:
      return REPOSITORIES_UNAVAILABLE;
    case DOMAIN_ERROR.REPOSITORY_IDEMPOTENCY_KEY:
      return null;
    default:
      throw error;
  }
}

/**
 * «Репозитории» в личке. Вне лички молчит.
 * Имена репозиториев в ответ попадают только после допуска домена.
 */
export async function replyToRepositories(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  actions: InstallationRepositories,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  try {
    const repositories = await actions.show({
      telegramUserId: String(from.id),
      chat: chatType,
      idempotencyKey,
    });
    return renderRepositories(repositories);
  } catch (error) {
    return replyOf(error);
  }
}

/** Сообщение «Репозитории» на единственном экземпляре grammY. */
export function attachInstallationRepositories(bot: Bot, actions: InstallationRepositories): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined || !parseRepositoriesMessage(text)) {
      await next();
      return;
    }
    traceHandler('installation-repositories');
    const reply = await replyToRepositories(ctx.chat?.type, ctx.from, String(ctx.update.update_id), actions);
    if (reply !== null) await ctx.reply(reply);
    await next();
  });
}
