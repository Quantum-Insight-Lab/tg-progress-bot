import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import { ISSUE_CALLBACK_PREFIX } from "../../src/telegram/callbacks.js";

export async function sendTask(
  bot: Bot,
  input: {
    chatId: number;
    telegramUserId: number;
    title?: string;
    issueId?: string;
    updateId?: number;
    callbackId?: string;
  },
): Promise<void> {
  const title = input.title ?? "Шаг";
  const updateId = input.updateId ?? 1;
  const issueId = input.issueId ?? "issue-1";
  const callbackId = input.callbackId ?? randomUUID();
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: updateId,
      chat: { id: input.chatId, type: "group", title: "Секретный" },
      from: { id: input.telegramUserId, is_bot: false, first_name: "A" },
      text: `/task ${title}`,
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
  await bot.handleUpdate({
    update_id: updateId + 10_000,
    callback_query: {
      id: callbackId,
      from: { id: input.telegramUserId, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data: `${ISSUE_CALLBACK_PREFIX}${issueId}`,
      message: {
        message_id: updateId,
        date: updateId,
        chat: { id: input.chatId, type: "group", title: "Секретный" },
        text: "Выберите issue",
      },
    },
  });
}
