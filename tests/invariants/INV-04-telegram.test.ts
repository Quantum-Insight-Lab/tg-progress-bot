import { beforeEach, expect, it } from "vitest";
import type { Bot, Transformer } from "grammy";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { createClock } from "../../src/infrastructure/clock.js";
import { CHECK_CALLBACK_PREFIX } from "../../src/telegram/day-list.js";
import { CONFIRM_CALLBACK_PREFIX, CONFIRM_QUESTION } from "../../src/telegram/callbacks.js";
import { resetBotForTests, wireTelegram } from "../../src/telegram/index.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";

const projectId = "p1";
const chatId = 100;
const memberTelegramId = 200;
const leadTelegramId = 201;

const lead: ProjectMember = {
  id: "m-lead",
  projectId,
  userId: "u-lead",
  role: "lead",
  topicId: null,
};

const member: ProjectMember = {
  id: "m-user",
  projectId,
  userId: "u-member",
  role: "member",
  topicId: 10,
};

beforeEach(() => {
  resetHandlerRegistry();
});

function intercept(bot: Bot): { texts: string[]; messages: { chat: unknown; text: string }[] } {
  const texts: string[] = [];
  const messages: { chat: unknown; text: string }[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (
      (method === "sendMessage" || method === "editMessageText") &&
      payload !== undefined &&
      "text" in payload
    ) {
      const text = String(payload.text);
      texts.push(text);
      if (method === "sendMessage" && "chat_id" in payload) {
        messages.push({ chat: payload.chat_id, text });
      }
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  return { texts, messages };
}

function wire(bot: Bot) {
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
    roster: [
      { projectId, userId: member.userId },
      { projectId, userId: lead.userId },
    ],
    leads: [{ userId: lead.userId, telegramUserId: String(leadTelegramId) }],
  });
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) => {
        if (pid !== projectId) {
          return undefined;
        }
        if (uid === lead.userId) {
          return lead;
        }
        if (uid === member.userId) {
          return member;
        }
        return undefined;
      },
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: projectId } : undefined,
      findUserByTelegramId: (id) => {
        if (id === String(memberTelegramId)) {
          return { id: member.userId };
        }
        if (id === String(leadTelegramId)) {
          return { id: lead.userId };
        }
        return undefined;
      },
    },
    dayList,
  });
  return dayList;
}

async function sendTask(bot: Bot): Promise<void> {
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: memberTelegramId, is_bot: false, first_name: "A" },
      text: "/task issue-1 Шаг",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
}

async function tap(
  bot: Bot,
  fromId: number,
  data: string,
  updateId: number,
  chat: { id: number; type: "group" | "private"; title?: string },
): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cq-${String(updateId)}`,
      from: { id: fromId, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat:
          chat.type === "private"
            ? { id: chat.id, type: "private", first_name: "A" }
            : { id: chat.id, type: "group", title: chat.title ?? "Секретный" },
        text: "21.09",
      },
    },
  });
}

it("INV-04: callback member не ставит DONE, lead ставит", async () => {
  const bot = resetBotForTests();
  const dayList = wire(bot);
  const captured = intercept(bot);
  await sendTask(bot);
  const item = dayList.lists[0]?.items[0];
  expect(item).toBeDefined();
  await tap(bot, memberTelegramId, `${CHECK_CALLBACK_PREFIX}${item?.id ?? ""}`, 2, {
    id: chatId,
    type: "group",
  });
  expect(dayList.tasks.get(item?.taskId ?? "")?.task.status).toBe("REVIEW");
  const questions = captured.messages.filter((message) =>
    message.text.includes(CONFIRM_QUESTION),
  );
  expect(questions).toEqual([{ chat: leadTelegramId, text: CONFIRM_QUESTION }]);
  await tap(
    bot,
    memberTelegramId,
    `${CONFIRM_CALLBACK_PREFIX}${item?.id ?? ""}`,
    3,
    { id: chatId, type: "group" },
  );
  expect(dayList.tasks.get(item?.taskId ?? "")?.task.status).toBe("REVIEW");
  expect(captured.texts).toContain("Нет доступа");
  await tap(
    bot,
    leadTelegramId,
    `${CONFIRM_CALLBACK_PREFIX}${item?.id ?? ""}`,
    4,
    { id: leadTelegramId, type: "private" },
  );
  expect(dayList.tasks.get(item?.taskId ?? "")?.task.status).toBe("DONE");
});
