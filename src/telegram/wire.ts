import type { Bot } from "grammy";
import type { MemberDirectory } from "../domain/projects/index.js";
import {
  bindGuardedCallbackQuery,
  bindGuardedCommand,
  bindGuardedPrivateText,
  type IdentityDirectories,
} from "./bind.js";
import {
  DISMISS_BLOCKER_PREFIX,
  ISSUE_CALLBACK_PREFIX,
  SCREEN_CALLBACK_PREFIX,
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
import { emptyScreenReader, type ScreenReader } from "../projections/index.js";
import {
  onScreenCallback,
  onScreenCommand,
  onStartMenu,
} from "./screens.js";
import { onTaskActCallback } from "./task-actions.js";
import {
  onBlockerReasonMessage,
  onDismissBlockerCallback,
} from "./stale.js";

/** Идентификаторы хендлеров бота; INV-12 перебирает этот список. */
export const TELEGRAM_HANDLER_IDS = [
  "telegram.start",
  "telegram.task",
  "telegram.pick_issue",
  "telegram.check",
  "telegram.act",
  "telegram.screen",
  "telegram.progress",
  "telegram.work",
  "telegram.done",
  "telegram.plan",
  "telegram.blockers",
  "telegram.github",
  "telegram.blocker_dismiss",
  "telegram.blocker_reason",
] as const;

export type { DayListStore };

export type TelegramDeps = {
  directory: MemberDirectory;
  identity: IdentityDirectories & {
    findProjectIdsByUserId?: ((userId: string) => readonly string[]) | undefined;
  };
  dayList: DayListStore;
  screens?: ScreenReader;
};

export function wireTelegram(bot: Bot, deps: TelegramDeps): void {
  const screens = deps.screens ?? emptyScreenReader();
  const identity: IdentityDirectories = {
    findProjectByChatId: deps.identity.findProjectByChatId,
    findUserByTelegramId: deps.identity.findUserByTelegramId,
    findProjectIdByCallback: (data) => {
      const itemId = itemIdFromCallback(data);
      if (itemId !== undefined) {
        return deps.dayList.projectIdOfItem(itemId);
      }
      if (data !== undefined && data.startsWith(DISMISS_BLOCKER_PREFIX)) {
        return deps.dayList.projectIdOfBlocker(
          data.slice(DISMISS_BLOCKER_PREFIX.length),
        );
      }
      return undefined;
    },
    findProjectIdByPrivateUser: (userId) =>
      deps.dayList.pendingAskOf(userId)?.projectId,
  };
  const screenIdentity = {
    findProjectIdsByUserId: deps.identity.findProjectIdsByUserId,
  };
  bindGuardedCommand({
    bot,
    id: "telegram.start",
    command: "start",
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx) => {
      await onStartMenu(ctx);
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
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.screen",
    trigger: new RegExp(`^${SCREEN_CALLBACK_PREFIX}`),
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onScreenCallback(
        ctx,
        access,
        member,
        deps.directory,
        screenIdentity,
        screens,
      );
    },
  });
  const commands: {
    id: (typeof TELEGRAM_HANDLER_IDS)[number];
    command: "progress" | "work" | "done" | "plan" | "blockers" | "github";
    kind: "progress" | "work" | "done" | "plan" | "blockers" | "github";
  }[] = [
    { id: "telegram.progress", command: "progress", kind: "progress" },
    { id: "telegram.work", command: "work", kind: "work" },
    { id: "telegram.done", command: "done", kind: "done" },
    { id: "telegram.plan", command: "plan", kind: "plan" },
    { id: "telegram.blockers", command: "blockers", kind: "blockers" },
    { id: "telegram.github", command: "github", kind: "github" },
  ];
  for (const entry of commands) {
    bindGuardedCommand({
      bot,
      id: entry.id,
      command: entry.command,
      directory: deps.directory,
      identity,
      onAuthorized: async (ctx, access, member) => {
        await onScreenCommand(
          ctx,
          access,
          member,
          deps.directory,
          screenIdentity,
          screens,
          entry.kind,
        );
      },
    });
  }
  bindGuardedCallbackQuery({
    bot,
    id: "telegram.blocker_dismiss",
    trigger: new RegExp(`^${DISMISS_BLOCKER_PREFIX}`),
    directory: deps.directory,
    identity,
    onAuthorized: async (ctx, access, member) => {
      await onDismissBlockerCallback(ctx, access, member, deps.dayList);
    },
  });
  bindGuardedPrivateText({
    bot,
    id: "telegram.blocker_reason",
    directory: deps.directory,
    identity,
    shouldHandle: (ctx) => {
      const telegramUserId = ctx.from?.id;
      if (telegramUserId === undefined) {
        return false;
      }
      const user = deps.identity.findUserByTelegramId(String(telegramUserId));
      if (user === undefined) {
        return false;
      }
      return deps.dayList.pendingAskOf(user.id) !== undefined;
    },
    onAuthorized: async (ctx, access, member) => {
      await onBlockerReasonMessage(ctx, access, member, deps.dayList);
    },
  });
}
