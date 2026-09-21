import type { Bot } from "grammy";
import type { MemberDirectory } from "../domain/projects/index.js";
import { bindGuardedCommand, type IdentityDirectories } from "./bind.js";

/** Идентификаторы хендлеров бота; INV-12 перебирает этот список. */
export const TELEGRAM_HANDLER_IDS = ["telegram.start"] as const;

export type TelegramDeps = {
  directory: MemberDirectory;
  identity: IdentityDirectories;
};

export function wireTelegram(bot: Bot, deps: TelegramDeps): void {
  bindGuardedCommand({
    bot,
    id: "telegram.start",
    command: "start",
    directory: deps.directory,
    identity: deps.identity,
    onAuthorized: async (ctx) => {
      await ctx.reply("Доступ есть");
    },
  });
}
