import type { Bot } from "grammy";
import type { MemberDirectory } from "../domain/projects/index.js";
import {
  bindGuardedCallbackQuery,
  bindGuardedCommand,
  type IdentityDirectories,
} from "./bind.js";
import {
  ISSUE_CALLBACK_PREFIX,
  TASK_ACT_CALLBACK_PATTERN,
  itemIdFromCallback,
} from "./callbacks.js";
import {
  CHECK_CALLBACK_PREFIX,
  onCheckCallback,
  onPickIssueCallback,
  onTaskCommand,
  type DayListStore,
} from "./day-list.js";
import { onTaskActCallback } from "./task-actions.js";

/** Идентификаторы хендлеров бота; INV-12 перебирает этот список. */
export const TELEGRAM_HANDLER_IDS = [
  "telegram.start",
  "telegram.task",
  "telegram.pick_issue",
  "telegram.check",
  "telegram.act",
] as const;

export type { DayListStore };

export type TelegramDeps = {
  directory: MemberDirectory;
  identity: IdentityDirectories;
  dayList: DayListStore;
};

export function wireTelegram(bot: Bot, deps: TelegramDeps): void {
  const identity: IdentityDirectories = {
    findProjectByChatId: deps.identity.findProjectByChatId,
    findUserByTelegramId: deps.identity.findUserByTelegramId,
    findProjectIdByCallback: (data) => {
      const itemId = itemIdFromCallback(data);
      if (itemId === undefined) {
        return undefined;
      }
      return deps.dayList.projectIdOfItem(itemId);
    },
  };
  bindGuardedCommand({
    bot,
    id: "telegram.start",
    command: "start",
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx) => {
      await ctx.reply("Доступ есть");
    },
  });
  bindGuardedCommand({
    bot,
    id: "telegram.task",
    command: "task",
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onTaskCommand(ctx, access, member, deps.dayList);
    },
  });
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.pick_issue",
    trigger: new RegExp(`^${ISSUE_CALLBACK_PREFIX}`),
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onPickIssueCallback(ctx, access, member, deps.dayList);
    },
  });
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.check",
    trigger: new RegExp(`^${CHECK_CALLBACK_PREFIX}`),
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onCheckCallback(ctx, access, member, deps.dayList);
    },
  });
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.act",
    trigger: TASK_ACT_CALLBACK_PATTERN,
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onTaskActCallback(ctx, access, member, deps.dayList);
    },
  });
}
