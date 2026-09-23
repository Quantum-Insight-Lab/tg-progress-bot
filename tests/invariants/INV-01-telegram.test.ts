import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Bot, Context, Transformer } from "grammy";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { createClock } from "../../src/infrastructure/clock.js";
import { applyMigrations } from "../../scripts/migrate.js";
import {
  ISSUE_CALLBACK_PREFIX,
  ISSUE_PICK_PROMPT,
} from "../../src/telegram/callbacks.js";
import { resetBotForTests, resolveAccess, wireTelegram } from "../../src/telegram/index.js";
import { memoryDayListStore, sampleIssue } from "../helpers/day-list-store.js";
import { repoRoot } from "../helpers/repo-root.js";
import { sendTask } from "../helpers/telegram-task.js";

const projectId = "p1";
const chatId = 100;
const telegramUserId = 200;
const lead: ProjectMember = {
  id: "m-lead",
  projectId,
  userId: "u-lead",
  role: "lead",
  topicId: null,
};

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetHandlerRegistry();
});

function intercept(bot: Bot): {
  texts: string[];
  callbacks: string[];
} {
  const texts: string[] = [];
  const callbacks: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (
      (method === "sendMessage" || method === "editMessageText") &&
      payload !== undefined &&
      "text" in payload
    ) {
      texts.push(String(payload.text));
    }
    if (
      payload !== undefined &&
      typeof payload === "object" &&
      "reply_markup" in payload
    ) {
      const markup = payload.reply_markup as
        | { inline_keyboard?: { callback_data?: string }[][] }
        | undefined;
      for (const row of markup?.inline_keyboard ?? []) {
        for (const button of row) {
          if (button.callback_data !== undefined) {
            callbacks.push(button.callback_data);
          }
        }
      }
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  return { texts, callbacks };
}

function wire(bot: Bot, issues = [sampleIssue(projectId)]) {
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
    issues,
  });
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) =>
        pid === projectId && uid === lead.userId ? lead : undefined,
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: projectId } : undefined,
      findUserByTelegramId: (id) =>
        id === String(telegramUserId) ? { id: lead.userId } : undefined,
    },
    dayList,
  });
  return dayList;
}

it("INV-01: без issue в зеркале задача не создаётся", async () => {
  const bot = resetBotForTests();
  const captured = intercept(bot);
  const dayList = wire(bot, []);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/task Шаг",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
  expect(captured.texts).toEqual(["Нужен issue своего проекта"]);
  expect(dayList.lists).toEqual([]);
  expect(dayList.tasks.size).toBe(0);
});

it("INV-01: задача создаётся только после выбора issue из зеркала", async () => {
  const bot = resetBotForTests();
  const captured = intercept(bot);
  const dayList = wire(bot, [
    sampleIssue(projectId),
    { id: "issue-9", projectId: "other", number: 9, title: "Чужой" },
  ]);
  await sendTask(bot, { chatId, telegramUserId, title: "Шаг" });
  expect(captured.texts[0]).toBe(ISSUE_PICK_PROMPT);
  expect(
    captured.callbacks.filter((data) => data.startsWith(ISSUE_CALLBACK_PREFIX)),
  ).toEqual([`${ISSUE_CALLBACK_PREFIX}issue-1`]);
  const task = [...dayList.tasks.values()][0]?.task;
  expect(task?.issueId).toBe("issue-1");
  expect(task?.title).toBe("Шаг");
});

it("INV-01: чужой issue из зеркала не принимается", async () => {
  const bot = resetBotForTests();
  const captured = intercept(bot);
  const dayList = wire(bot);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/task Шаг",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "cq-bad",
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data: `${ISSUE_CALLBACK_PREFIX}issue-foreign`,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "group", title: "Секретный" },
        text: ISSUE_PICK_PROMPT,
      },
    },
  });
  expect(captured.texts).toContain("Нужен issue своего проекта");
  expect(dayList.tasks.size).toBe(0);
});

it("INV-01: telegram не ходит в живой GitHub API", () => {
  const root = join(repoRoot, "src/telegram");
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const text = readFileSync(full, "utf8");
      if (
        text.includes("githubClient") ||
        text.includes('from "../github') ||
        text.includes('from "../../github')
      ) {
        hits.push(full);
      }
    }
  }
  walk(root);
  expect(hits).toEqual([]);
});

it("INV-01: кнопка issue открывает проект черновика", () => {
  const ctx = {
    from: { id: telegramUserId },
    chat: { id: chatId },
    callbackQuery: { data: `${ISSUE_CALLBACK_PREFIX}issue-1` },
  } as Context;
  const access = resolveAccess(ctx, {
    findProjectByChatId: () => ({ id: "other-project" }),
    findUserByTelegramId: () => ({ id: lead.userId }),
    findProjectIdByPendingTask: () => projectId,
  });
  expect(access).toEqual({ projectId, userId: lead.userId });
});
