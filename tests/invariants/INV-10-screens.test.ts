import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Transformer } from "grammy";
import { formatProgress } from "../../src/domain/progress/index.js";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { emit } from "../../src/events/emit.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import {
  dbScreenReader,
  githubState,
  planQueue,
  projectProgress,
  workBoard,
} from "../../src/projections/index.js";
import { clock } from "../../src/infrastructure/clock.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject, type Seed } from "../helpers/domain-seed.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import { resetBotForTests, wireTelegram } from "../../src/telegram/index.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetHandlerRegistry();
});

it("INV-10: карточки не складывают проценты разных проектов", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [
    "DONE",
    await insertTask(pool, home),
  ]);
  await insertTask(pool, other);
  const cards = await projectProgress([home.projectId, other.projectId]);
  expect(cards).toHaveLength(2);
  const homeCard = cards.find((card) => card.projectId === home.projectId);
  const otherCard = cards.find((card) => card.projectId === other.projectId);
  expect(homeCard?.tasks.some((task) => task.status === "DONE")).toBe(true);
  expect(otherCard?.tasks.every((task) => task.status !== "DONE")).toBe(true);
});

it("INV-11: пустой проект на экране — «Нет данных», не 0%", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const cards = await projectProgress([seed.projectId]);
  expect(cards[0]?.tasks).toEqual([]);
  expect(formatProgress(null)).toBe("Нет данных");
});

it("INV-10: GitHub показывает issues без задач своего проекта", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const before = await githubState([home.projectId]);
  expect(before[0]?.issuesWithoutTasks.some((issue) => issue.title === "Issue")).toBe(
    true,
  );
  await insertTask(pool, home);
  const after = await githubState([home.projectId]);
  expect(after[0]?.issuesWithoutTasks).toEqual([]);
});

it("INV-10: план одного проекта не содержит задачи другого", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  const homeTask = await insertTask(pool, home);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [
    "PLANNED",
    homeTask,
  ]);
  const otherTask = await insertTask(pool, other);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [
    "PLANNED",
    otherTask,
  ]);
  const queue = await planQueue([home.projectId]);
  expect(queue).toHaveLength(1);
  expect(queue[0]?.items).toHaveLength(1);
});

it("INV-10: /progress — карточка на проект, без общего процента", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [
    "DONE",
    await insertTask(pool, home),
  ]);
  const chatId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
  const telegramUserId = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 8),
    16,
  );
  await pool.query(`UPDATE users SET telegram_user_id = $1 WHERE id = $2`, [
    telegramUserId,
    home.userId,
  ]);
  await pool.query(`UPDATE projects SET telegram_chat_id = $1 WHERE id = $2`, [
    chatId,
    home.projectId,
  ]);
  const member: ProjectMember = {
    id: "m-screen",
    projectId: home.projectId,
    userId: home.userId,
    role: "lead",
    topicId: null,
  };
  const bot = resetBotForTests();
  const texts: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (method === "sendMessage" && payload !== undefined && "text" in payload) {
      texts.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) =>
        pid === home.projectId && uid === home.userId ? member : undefined,
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: home.projectId } : undefined,
      findUserByTelegramId: (id) =>
        id === String(telegramUserId) ? { id: home.userId } : undefined,
    },
    dayList: memoryDayListStore(),
    screens: dbScreenReader(),
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/progress",
      entities: [{ offset: 0, length: 9, type: "bot_command" }],
    },
  });
  expect(texts.join("\n")).toMatch(/100%/);
  expect(texts.join("\n")).toMatch(/выполнено 1/);
  expect(texts.join("\n")).not.toMatch(/Все проекты/i);
});

it("INV-11: /progress без задач печатает «Нет данных»", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const chatId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
  const telegramUserId = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 8),
    16,
  );
  await pool.query(`UPDATE users SET telegram_user_id = $1 WHERE id = $2`, [
    telegramUserId,
    seed.userId,
  ]);
  await pool.query(`UPDATE projects SET telegram_chat_id = $1 WHERE id = $2`, [
    chatId,
    seed.projectId,
  ]);
  const member: ProjectMember = {
    id: "m-empty",
    projectId: seed.projectId,
    userId: seed.userId,
    role: "lead",
    topicId: null,
  };
  const bot = resetBotForTests();
  const texts: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (method === "sendMessage" && payload !== undefined && "text" in payload) {
      texts.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) =>
        pid === seed.projectId && uid === seed.userId ? member : undefined,
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: seed.projectId } : undefined,
      findUserByTelegramId: (id) =>
        id === String(telegramUserId) ? { id: seed.userId } : undefined,
    },
    dayList: memoryDayListStore(),
    screens: dbScreenReader(),
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/progress",
      entities: [{ offset: 0, length: 9, type: "bot_command" }],
    },
  });
  expect(texts.join("\n")).toContain("Нет данных");
  expect(texts.join("\n")).not.toMatch(/\b0%/);
});

function previousDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  return new Date(utc - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function replyOf(seed: Seed, command: string): Promise<string> {
  const chatId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
  const telegramUserId = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 8),
    16,
  );
  const pool = getPool();
  await pool.query(`UPDATE users SET telegram_user_id = $1 WHERE id = $2`, [
    telegramUserId,
    seed.userId,
  ]);
  await pool.query(`UPDATE projects SET telegram_chat_id = $1 WHERE id = $2`, [
    chatId,
    seed.projectId,
  ]);
  const member: ProjectMember = {
    id: `m-${command}-${seed.projectId.slice(0, 8)}`,
    projectId: seed.projectId,
    userId: seed.userId,
    role: "lead",
    topicId: null,
  };
  const bot = resetBotForTests();
  const texts: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (method === "sendMessage" && payload !== undefined && "text" in payload) {
      texts.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  wireTelegram(bot, {
    directory: {
      find: (pid, uid) =>
        pid === seed.projectId && uid === seed.userId ? member : undefined,
    },
    identity: {
      findProjectByChatId: (id) =>
        id === String(chatId) ? { id: seed.projectId } : undefined,
      findUserByTelegramId: (id) =>
        id === String(telegramUserId) ? { id: seed.userId } : undefined,
    },
    dayList: memoryDayListStore(),
    screens: dbScreenReader(),
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: "Секретный" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: `/${command}`,
      entities: [{ offset: 0, length: command.length + 1, type: "bot_command" }],
    },
  });
  return texts.join("\n");
}

it("INV-10: /progress печатает «Последнее изменение» из события задачи", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const taskId = await insertTask(pool, seed);
  await emit(EVENT_TYPES.TASK_CREATED, {
    actor: { id: seed.userId, role: "member" },
    subject: { entity: "Task", id: taskId },
    payload: {
      task_id: taskId,
      project_id: seed.projectId,
      issue_id: seed.issueId,
      title: "Task",
      assignee_id: seed.userId,
      priority: "normal",
      target: "today",
    },
    idempotencyKey: `created:${taskId}`,
  });
  const text = await replyOf(seed, "progress");
  expect(text).toMatch(/Последнее изменение: \d{2}\.\d{2}\.\d{4}/);
  expect(text).not.toMatch(/Все проекты/i);
});

it("INV-10: /work печатает исполнителя и день переноса", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const taskId = await insertTask(pool, seed);
  const login = `andrey-${seed.userId.slice(0, 8)}`;
  await pool.query(`UPDATE users SET github_login = $1 WHERE id = $2`, [
    login,
    seed.userId,
  ]);
  const today = clock.calendarDate("Asia/Bangkok");
  const yesterday = previousDay(today);
  const oldListId = randomUUID();
  const newListId = randomUUID();
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [oldListId, seed.projectId, yesterday],
  );
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [newListId, seed.projectId, today],
  );
  await pool.query(
    `INSERT INTO task_list_items
      (id, project_id, list_id, task_id, position, is_done, carried_from_list_id)
     VALUES ($1, $2, $3, $4, 0, TRUE, NULL)`,
    [randomUUID(), seed.projectId, oldListId, taskId],
  );
  await pool.query(
    `INSERT INTO task_list_items
      (id, project_id, list_id, task_id, position, is_done, carried_from_list_id)
     VALUES ($1, $2, $3, $4, 0, FALSE, $5)`,
    [randomUUID(), seed.projectId, newListId, taskId, oldListId],
  );
  const board = await workBoard([seed.projectId]);
  expect(board[0]?.items[0]?.assigneeLogin).toBe(login);
  expect(board[0]?.items[0]?.dayNumber).toBe(2);
  const text = await replyOf(seed, "work");
  expect(text).toContain(login);
  expect(text).toContain("день 2");
  expect(text).not.toMatch(/commit/i);
});

it("INV-10: /done печатает дату из task.confirmed", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const taskId = await insertTask(pool, seed);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, ["DONE", taskId]);
  await emit(EVENT_TYPES.TASK_CONFIRMED, {
    actor: { id: seed.userId, role: "lead" },
    subject: { entity: "Task", id: taskId },
    payload: { task_id: taskId, confirmed_by: seed.userId },
    idempotencyKey: `confirmed:${taskId}`,
  });
  const text = await replyOf(seed, "done");
  expect(text).toMatch(/подтверждено \d{2}\.\d{2}\.\d{4}/);
});
