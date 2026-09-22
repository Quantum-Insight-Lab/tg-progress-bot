import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Bot, Transformer } from "grammy";
import { constants, githubReconcileIntervalMs } from "../../src/config/index.js";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { createClock } from "../../src/infrastructure/clock.js";
import { applyMigrations } from "../../scripts/migrate.js";
import {
  BLOCKER_ASK_HINT,
  DISMISS_BLOCKER_PREFIX,
  NO_BLOCKER_LABEL,
} from "../../src/telegram/callbacks.js";
import {
  resetBotForTests,
  scanStaleTasks,
  wireTelegram,
} from "../../src/telegram/index.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import type { Task, TaskList } from "../../src/domain/tasks/index.js";

const projectId = "p1";
const chatId = 100;
const memberTelegramId = 200;
const today = "2026-09-21";

const member: ProjectMember = {
  id: "m-user",
  projectId,
  userId: "u-member",
  role: "member",
  topicId: 10,
};

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetHandlerRegistry();
});

function intercept(bot: Bot): { texts: string[] } {
  const texts: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (
      (method === "sendMessage" || method === "editMessageText") &&
      payload !== undefined &&
      "text" in payload
    ) {
      texts.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  return { texts };
}

function staleLists(taskId: string): TaskList[] {
  const day1 = "2026-09-19";
  const day2 = "2026-09-20";
  return [
    {
      id: "list-1",
      projectId,
      listDate: day1,
      topicId: 10,
      messageId: null,
      items: [
        {
          id: "item-1",
          projectId,
          listId: "list-1",
          taskId,
          position: 0,
          isDone: true,
          carriedFromListId: null,
        },
      ],
    },
    {
      id: "list-2",
      projectId,
      listDate: day2,
      topicId: 10,
      messageId: null,
      items: [
        {
          id: "item-2",
          projectId,
          listId: "list-2",
          taskId,
          position: 0,
          isDone: true,
          carriedFromListId: "list-1",
        },
      ],
    },
    {
      id: "list-3",
      projectId,
      listDate: today,
      topicId: 10,
      messageId: null,
      items: [
        {
          id: "item-3",
          projectId,
          listId: "list-3",
          taskId,
          position: 0,
          isDone: false,
          carriedFromListId: "list-2",
        },
      ],
    },
  ];
}

function taskOf(): Task {
  return {
    id: "task-1",
    projectId,
    issueId: "issue-1",
    assigneeId: member.userId,
    title: "AI-12",
    status: "IN_PROGRESS",
    priority: "normal",
    createdByUserId: member.userId,
  };
}

function wire(bot: Bot, lists: TaskList[]) {
  const dayList = memoryDayListStore({
    clock: createClock({
      current: () => new Date("2026-09-21T05:00:00.000Z"),
    }),
    timeZone: "Asia/Bangkok",
    lists,
    roster: [{ projectId, userId: member.userId }],
    telegramUsers: [
      { userId: member.userId, telegramUserId: String(memberTelegramId) },
    ],
  });
  dayList.saveTask(taskOf(), []);
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) =>
        pid === projectId && uid === member.userId ? member : undefined,
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: projectId } : undefined,
      findUserByTelegramId: (id) =>
        id === String(memberTelegramId) ? { id: member.userId } : undefined,
    },
    dayList,
  });
  return dayList;
}

it("INV-13: застой — вопрос в личку, «нет блокера» возвращает IN_PROGRESS", async () => {
  const bot = resetBotForTests();
  const captured = intercept(bot);
  const dayList = wire(bot, staleLists("task-1"));
  await scanStaleTasks(bot, dayList, { projectId, githubLagMs: null });
  const ask = captured.texts.find((text) => text.includes(BLOCKER_ASK_HINT));
  expect(ask).toContain("3-й день");
  expect(ask).toContain(BLOCKER_ASK_HINT);
  expect(dayList.tasks.get("task-1")?.task.status).toBe("BLOCKED");
  const blockerId = dayList.pendingAskOf(member.userId)?.blockerId;
  expect(blockerId).toBeDefined();
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: "cq-2",
      from: { id: memberTelegramId, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data: `${DISMISS_BLOCKER_PREFIX}${blockerId ?? ""}`,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: memberTelegramId, type: "private", first_name: "A" },
        text: ask ?? "",
      },
    },
  });
  expect(dayList.tasks.get("task-1")?.task.status).toBe("IN_PROGRESS");
  expect(NO_BLOCKER_LABEL).toBe("нет блокера");
});

it("INV-13: строка в ответ становится причиной блокера", async () => {
  const bot = resetBotForTests();
  intercept(bot);
  const dayList = wire(bot, staleLists("task-1"));
  await scanStaleTasks(bot, dayList, { projectId, githubLagMs: null });
  expect(dayList.tasks.get("task-1")?.task.status).toBe("BLOCKED");
  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: 1,
      chat: { id: memberTelegramId, type: "private", first_name: "A" },
      from: { id: memberTelegramId, is_bot: false, first_name: "A" },
      text: "нет доступа к источнику",
    },
  });
  const blockers = dayList.tasks.get("task-1")?.blockers ?? [];
  expect(blockers.some((blocker) => blocker.reason === "нет доступа к источнику")).toBe(
    true,
  );
  expect(dayList.tasks.get("task-1")?.task.status).toBe("BLOCKED");
});

it("INV-13: повторный вопрос в тот же день не уходит", async () => {
  const bot = resetBotForTests();
  const captured = intercept(bot);
  const dayList = wire(bot, staleLists("task-1"));
  await scanStaleTasks(bot, dayList, { projectId, githubLagMs: null });
  await scanStaleTasks(bot, dayList, { projectId, githubLagMs: null });
  expect(captured.texts.filter((text) => text.includes(BLOCKER_ASK_HINT))).toHaveLength(
    1,
  );
});

it("INV-13: без данных GitHub CI-сигнал не ставится", async () => {
  const bot = resetBotForTests();
  intercept(bot);
  const dayList = wire(bot, staleLists("task-1"));
  await scanStaleTasks(bot, dayList, {
    projectId,
    githubLagMs: null,
    githubFactsByTaskId: new Map([
      [
        "task-1",
        {
          ciRed: true,
          prIdleDays: constants.staleDays + 1,
          issueIdleDays: 0,
          noBranchDays: 0,
        },
      ],
    ]),
  });
  const signals = (dayList.tasks.get("task-1")?.blockers ?? []).map(
    (blocker) => blocker.signalType,
  );
  expect(signals).toEqual(["no_check"]);
});

it("INV-13: при лаге ≥ C-6 CI-сигнал не ставится, задачи ведутся", async () => {
  const bot = resetBotForTests();
  intercept(bot);
  const dayList = wire(bot, staleLists("task-1"));
  await scanStaleTasks(bot, dayList, {
    projectId,
    githubLagMs: githubReconcileIntervalMs(),
    githubFactsByTaskId: new Map([
      [
        "task-1",
        {
          ciRed: true,
          prIdleDays: constants.staleDays + 1,
          issueIdleDays: 0,
          noBranchDays: 0,
        },
      ],
    ]),
  });
  const signals = (dayList.tasks.get("task-1")?.blockers ?? []).map(
    (blocker) => blocker.signalType,
  );
  expect(signals).toEqual(["no_check"]);
  expect(dayList.tasks.get("task-1")?.task.status).toBe("BLOCKED");
});
