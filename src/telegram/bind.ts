import type { Bot, Context } from "grammy";
import {
  registerGuardedHandler,
  requireMember,
  type MemberDirectory,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";
import { DomainError } from "../domain/shared/errors.js";
import { logger } from "../infrastructure/logger.js";
import { recordRejectedCommand } from "../observability/index.js";
import { ISSUE_CALLBACK_PREFIX } from "./callbacks.js";

export type IdentityDirectories = {
  findProjectByChatId: (chatId: string) => { id: string } | undefined;
  findUserByTelegramId: (telegramUserId: string) => { id: string } | undefined;
  findProjectIdByCallback?: (data: string | undefined) => string | undefined;
  findProjectIdByPrivateUser?: (userId: string) => string | undefined;
  findProjectIdByPendingTask?: (userId: string) => string | undefined;
};

/** Журнал каждого обновления. Регистрация здесь, чтобы guard оставался единственной точкой входа (INV-12). */
export function attachTelegramLog(instance: Bot): void {
  instance.use(async (ctx, next) => {
    const message = ctx.message;
    logger.info("telegram.update", {
      update_id: ctx.update.update_id,
      chat_id: ctx.chat?.id,
      user_id: ctx.from?.id,
      text: message !== undefined && "text" in message ? message.text : undefined,
      data: ctx.callbackQuery?.data,
    });
    await next();
  });
}

export function resolveAccess(
  ctx: Context,
  identity: IdentityDirectories,
): ProjectAccess | undefined {
  const telegramUserId = ctx.from?.id;
  if (telegramUserId === undefined) {
    return undefined;
  }
  const user = identity.findUserByTelegramId(String(telegramUserId));
  if (user === undefined) {
    return undefined;
  }
  const data = ctx.callbackQuery?.data;
  if (data !== undefined && data.startsWith(ISSUE_CALLBACK_PREFIX)) {
    const draftProject = identity.findProjectIdByPendingTask?.(user.id);
    if (draftProject !== undefined) {
      return { projectId: draftProject, userId: user.id };
    }
  }
  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    const project = identity.findProjectByChatId(String(chatId));
    if (project !== undefined) {
      return { projectId: project.id, userId: user.id };
    }
  }
  const projectId = identity.findProjectIdByCallback?.(ctx.callbackQuery?.data);
  if (projectId !== undefined) {
    return { projectId, userId: user.id };
  }
  const privateProjectId = identity.findProjectIdByPrivateUser?.(user.id);
  if (privateProjectId !== undefined) {
    return { projectId: privateProjectId, userId: user.id };
  }
  return undefined;
}

async function replyDenied(ctx: Context, error: unknown): Promise<boolean> {
    if (error instanceof DomainError) {
      recordRejectedCommand(error.code);
      logger.warn("command.rejected", { code: error.code, message: error.message });
      if (ctx.callbackQuery !== undefined) {
        await ctx.answerCallbackQuery();
      }
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

/** Инлайн-кнопка: тот же factory-guard (INV-12). */
export function bindGuardedCallbackQuery(input: {
  bot: Bot;
  id: string;
  trigger: RegExp;
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
      instance.callbackQuery(input.trigger, listener);
    },
    onAuthorized: input.onAuthorized,
  });
}

/** Текст в личке: тот же factory-guard (INV-12). */
export function bindGuardedPrivateText(input: {
  bot: Bot;
  id: string;
  directory: MemberDirectory;
  identity: IdentityDirectories;
  shouldHandle: (ctx: Context) => boolean;
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
      instance.on("message:text", async (ctx, next) => {
        const text = ctx.message?.text ?? "";
        if (
          text.startsWith("/") ||
          ctx.chat?.type !== "private" ||
          !input.shouldHandle(ctx)
        ) {
          await next();
          return;
        }
        await listener(ctx);
      });
    },
    onAuthorized: input.onAuthorized,
  });
}
