import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { Bot, Transformer } from "grammy";
import { constants } from "../../src/config/index.js";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import type { TaskList } from "../../src/domain/tasks/index.js";
import { createClock } from "../../src/infrastructure/clock.js";
import {
  CHECK_CALLBACK_PREFIX,
} from "../../src/telegram/day-list.js";
import {
  resetBotForTests,
  wireTelegram,
} from "../../src/telegram/index.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import { repoRoot } from "../helpers/repo-root.js";

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

beforeEach(() => {
  resetHandlerRegistry();
});

function intercept(bot: Bot): {
  texts: string[];
  methods: string[];
} {
  const texts: string[] = [];
  const methods: string[] = [];
  let nextMessageId = 1;
  const fake: Transformer = (_prev, method, payload) => {
    methods.push(method);
    if (
      (method === "sendMessage" || method === "editMessageText") &&
      payload !== undefined &&
      "text" in payload
    ) {
      texts.push(String(payload.text));
    }
    const id = nextMessageId;
    nextMessageId += 1;
    return Promise.resolve({ ok: true, result: { message_id: id } as never });
  };
  bot.api.config.use(fake);
  return { texts, methods };
}

async function sendTask(bot: Bot, title = "Шаг"): Promise<void> {
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: `/task issue-1 ${title}`,
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
}

it("INV-06: второй /task правит то же сообщение, не шлёт второе", async () => {
  const bot = resetBotForTests();
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
  });
  const captured = intercept(bot);
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
  await sendTask(bot, "Первая");
  await sendTask(bot, "Вторая");
  const listSends = captured.methods.filter((method) => method === "sendMessage");
  const edits = captured.methods.filter((method) => method === "editMessageText");
  expect(listSends).toHaveLength(1);
  expect(edits).toHaveLength(1);
  expect(dayList.lists).toHaveLength(1);
  expect(captured.texts.some((text) => text.includes("21.09"))).toBe(true);
  expect(captured.texts.join("\n")).not.toMatch(/Секретный/i);
});

it("INV-06: C-5 полный список — отказ, второе сообщение не создаётся", async () => {
  const openedItems = Array.from(
    { length: constants.dayListMaxItems },
    (_, index) => ({
      id: `item-${String(index)}`,
      projectId,
      listId: "list-full",
      taskId: `task-${String(index)}`,
      position: index,
      isDone: false,
      carriedFromListId: null,
    }),
  );
  const full: TaskList = {
    id: "list-full",
    projectId,
    listDate: "2026-09-21",
    topicId: null,
    messageId: 10,
    items: openedItems,
  };
  const bot = resetBotForTests();
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
    lists: [full],
  });
  const captured = intercept(bot);
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
  await sendTask(bot, "Лишняя");
  expect(captured.texts).toEqual(["Список дня заполнен"]);
  expect(captured.methods.filter((method) => method === "sendMessage")).toHaveLength(
    1,
  );
  expect(captured.methods.filter((method) => method === "editMessageText")).toEqual(
    [],
  );
  expect(dayList.lists).toHaveLength(1);
});

it("INV-06: галочка редактирует то же сообщение", async () => {
  const bot = resetBotForTests();
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
  });
  const captured = intercept(bot);
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
  await sendTask(bot);
  const item = dayList.lists[0]?.items[0];
  expect(item).toBeDefined();
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "cq-1",
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data: `${CHECK_CALLBACK_PREFIX}${item?.id ?? ""}`,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "group", title: "Секретный" },
        text: "21.09",
      },
    },
  });
  expect(captured.methods.filter((method) => method === "editMessageText").length).toBeGreaterThan(
    0,
  );
  expect(dayList.lists[0]?.items[0]?.isDone).toBe(true);
  expect(captured.texts.join("\n")).toMatch(/✅/);
});

it("INV-06: sendChecklist в telegram нет", () => {
  const root = join(repoRoot, "src/telegram");
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("sendChecklist")) {
        hits.push(full);
      }
    }
  }
  walk(root);
  expect(hits).toEqual([]);
});
