import type { Bot } from "grammy";
import type { MemberDirectory } from "../domain/projects/index.js";
import {
  bindGuardedCallbackQuery,
  bindGuardedCommand,
  type IdentityDirectories,
} from "./bind.js";
import {
  CHECK_CALLBACK_PREFIX,
  onCheckCallback,
  onTaskCommand,
  type DayListStore,
} from "./day-list.js";

/** Идентификаторы хендлеров бота; INV-12 перебирает этот список. */
export const TELEGRAM_HANDLER_IDS = [
  "telegram.start",
  "telegram.task",
  "telegram.check",
] as const;

export type { DayListStore };

export type TelegramDeps = {
  directory: MemberDirectory;
  identity: IdentityDirectories;
  dayList: DayListStore;
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
  bindGuardedCommand({
    bot,
    id: "telegram.task",
    command: "task",
    directory: deps.directory,
    identity: deps.identity,
    onAuthorized: async (ctx, access, member) => {
      await onTaskCommand(ctx, access, member, deps.dayList);
    },
  });
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.check",
    trigger: new RegExp(`^${CHECK_CALLBACK_PREFIX}`),
    directory: deps.directory,
    identity: deps.identity,
    onAuthorized: async (ctx, access, member) => {
      await onCheckCallback(ctx, access, member, deps.dayList);
    },
  });
}
