import type { Bot, Context } from "grammy";
import {
  registerGuardedHandler,
  requireMember,
  type MemberDirectory,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";
import { DomainError } from "../domain/shared/errors.js";

export type IdentityDirectories = {
  findProjectByChatId: (chatId: string) => { id: string } | undefined;
  findUserByTelegramId: (telegramUserId: string) => { id: string } | undefined;
};

export function resolveAccess(
  ctx: Context,
  identity: IdentityDirectories,
): ProjectAccess | undefined {
  const chatId = ctx.chat?.id;
  const telegramUserId = ctx.from?.id;
  if (chatId === undefined || telegramUserId === undefined) {
    return undefined;
  }
  const project = identity.findProjectByChatId(String(chatId));
  const user = identity.findUserByTelegramId(String(telegramUserId));
  if (project === undefined || user === undefined) {
    return undefined;
  }
  return { projectId: project.id, userId: user.id };
}

async function replyDenied(ctx: Context, error: unknown): Promise<boolean> {
  if (error instanceof DomainError) {
    await ctx.reply(error.message);
    return true;
  }
  return false;
}

function bindGuardedListener(input: {
  bot: Bot;
  id: string;
  directory: MemberDirectory;
  identity: IdentityDirectories;
  attach: (bot: Bot, listener: (ctx: Context) => Promise<void>) => void;
  onAuthorized: (
    ctx: Context,
    access: ProjectAccess,
    member: ProjectMember,
  ) => Promise<void>;
}): void {
  const authorize = registerGuardedHandler(
    input.id,
    input.directory,
    (_access: ProjectAccess, member) => member,
  );
  input.attach(input.bot, async (ctx) => {
    try {
      const access = resolveAccess(ctx, input.identity);
      if (access === undefined) {
        requireMember(undefined);
        return;
      }
      const member = await authorize(access);
      await input.onAuthorized(ctx, access, member);
    } catch (error) {
      if (await replyDenied(ctx, error)) {
        return;
      }
      throw error;
    }
  });
}

/** Команда Telegram: guard навешивает factory, не хендлер (INV-12). */
export function bindGuardedCommand(input: {
  bot: Bot;
  id: string;
  command: string;
  directory: MemberDirectory;
  identity: IdentityDirectories;
  onAuthorized: (
    ctx: Context,
    access: ProjectAccess,
    member: ProjectMember,
  ) => Promise<void>;
}): void {
  bindGuardedListener({
    bot: input.bot,
    id: input.id,
    directory: input.directory,
    identity: input.identity,
    attach: (instance, listener) => {
      instance.command(input.command, listener);
    },
    onAuthorized: input.onAuthorized,
  });
}
