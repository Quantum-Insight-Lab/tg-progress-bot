import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { Bot, Transformer } from "grammy";
import { DomainError } from "../../src/domain/shared/errors.js";
import {
  addMember,
  registerGuardedHandler,
  registeredHandlers,
  removeMember,
  requireMember,
  resetHandlerRegistry,
  type MemberDirectory,
  type Project,
  type ProjectMember,
} from "../../src/domain/projects/index.js";
import { EVENT_TYPES } from "../../src/events/generated/event-types.js";
import {
  resetBotForTests,
  TELEGRAM_HANDLER_IDS,
  wireTelegram,
} from "../../src/telegram/index.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import { repoRoot } from "../helpers/repo-root.js";

const project: Project = {
  id: "p1",
  name: "Секретный проект",
  repository: "org/repo",
  timezone: "Asia/Bangkok",
  telegramChatId: "1",
};

const lead: ProjectMember = {
  id: "m-lead",
  projectId: project.id,
  userId: "u-lead",
  role: "lead",
  topicId: null,
};

const member: ProjectMember = {
  id: "m-user",
  projectId: project.id,
  userId: "u-member",
  role: "member",
  topicId: 10,
};

beforeEach(() => {
  resetHandlerRegistry();
});

it("INV-12: неизвестный пользователь отклонён", () => {
  try {
    requireMember(undefined);
    expect.fail("ожидали отказ");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const denied = error as DomainError;
    expect(denied.code).toBe("not_a_member");
    expect(denied.message).not.toMatch(/Секретный|p1|org\/repo/i);
  }
});

it("INV-12: фабрика не вызывает хендлер и не отдаёт данные не-участнику", async () => {
  const roster = [lead];
  let called = false;
  const handle = registerGuardedHandler(
    "report",
    {
      find: (projectId, userId) =>
        roster.find((m) => m.projectId === projectId && m.userId === userId),
    },
    () => {
      called = true;
      return project.name;
    },
  );
  await expect(
    handle({ projectId: project.id, userId: "stranger" }),
  ).rejects.toMatchObject({ code: "not_a_member" });
  expect(called).toBe(false);
  expect(registeredHandlers().every((h) => h.guarded)).toBe(true);
});

it("INV-12: участник проходит guard", async () => {
  const roster = [lead];
  const handle = registerGuardedHandler(
    "ok",
    {
      find: (projectId, userId) =>
        roster.find((m) => m.projectId === projectId && m.userId === userId),
    },
    (_input, current) => current.role,
  );
  await expect(
    handle({ projectId: project.id, userId: lead.userId }),
  ).resolves.toBe("lead");
});

it("lead добавляет участника и публикует project.member_added", () => {
  const result = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  expect(result.applied).toBe(true);
  expect(result.roster).toHaveLength(2);
  expect(result.event?.type).toBe(EVENT_TYPES.PROJECT_MEMBER_ADDED);
  expect(result.event?.payload).toEqual({
    project_id: project.id,
    user_id: member.userId,
    role: "member",
    topic_id: 10,
  });
});

it("повторное добавление того же участника не меняет состав", () => {
  const first = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  const second = addMember({
    roster: first.roster,
    actorUserId: lead.userId,
    member,
  });
  expect(second.applied).toBe(false);
  expect(second.event).toBeNull();
  expect(second.roster).toHaveLength(2);
});

it("member не может добавить участника", () => {
  expect(() =>
    addMember({
      roster: [lead, member],
      actorUserId: member.userId,
      member: {
        id: "m2",
        projectId: project.id,
        userId: "u2",
        role: "viewer",
        topicId: null,
      },
    }),
  ).toThrow(DomainError);
});

it("lead снимает участника; доступ после снятия закрыт", () => {
  const added = addMember({
    roster: [lead],
    actorUserId: lead.userId,
    member,
  });
  const removed = removeMember({
    roster: added.roster,
    actorUserId: lead.userId,
    projectId: project.id,
    userId: member.userId,
    removedAt: "2026-09-21T00:00:00.000Z",
  });
  expect(removed.applied).toBe(true);
  expect(removed.event?.type).toBe(EVENT_TYPES.PROJECT_MEMBER_REMOVED);
  expect(
    removed.roster.find((m) => m.userId === member.userId),
  ).toBeUndefined();
  expect(() =>
    requireMember(
      removed.roster.find(
        (m) => m.projectId === project.id && m.userId === member.userId,
      ),
    ),
  ).toThrow(DomainError);
});

const leak = /Секретный|p1|org\/repo/i;
const chatId = 100;
const telegramUserId = 200;

function directoryOf(roster: readonly ProjectMember[]): MemberDirectory {
  return {
    find: (projectId, userId) =>
      roster.find((m) => m.projectId === projectId && m.userId === userId),
  };
}

function identityFor(userId: string) {
  return {
    findProjectByChatId: (id: string) =>
      id === String(chatId) ? { id: project.id } : undefined,
    findUserByTelegramId: (id: string) =>
      id === String(telegramUserId) ? { id: userId } : undefined,
  };
}

function interceptReplies(bot: Bot): string[] {
  const texts: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (method === "sendMessage" && payload !== undefined && "text" in payload) {
      texts.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(fake);
  return texts;
}

async function sendStart(bot: Bot, fromId: number): Promise<void> {
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "group", title: project.name },
      from: { id: fromId, is_bot: false, first_name: "A" },
      text: "/start",
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  });
}

function listTelegramTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTelegramTs(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

it("INV-12: реестр хендлеров бота перебирается и каждый с guard", () => {
  const bot = resetBotForTests();
  wireTelegram(bot, {
    directory: directoryOf([lead]),
    identity: identityFor(lead.userId),
    dayList: memoryDayListStore(),
  });
  const registered = registeredHandlers();
  expect(registered.map((handler) => handler.id)).toEqual([
    ...TELEGRAM_HANDLER_IDS,
  ]);
  for (const handler of registered) {
    expect(handler.guarded).toBe(true);
  }
});

it("INV-12: не-участник получает отказ без данных проекта", async () => {
  const bot = resetBotForTests();
  const replies = interceptReplies(bot);
  wireTelegram(bot, {
    directory: directoryOf([lead]),
    identity: identityFor(lead.userId),
    dayList: memoryDayListStore(),
  });
  await sendStart(bot, 999);
  expect(replies).toEqual(["Нет доступа"]);
  expect(replies.join("\n")).not.toMatch(leak);
});

it("INV-12: пользователь без членства не видит данные проекта", async () => {
  const bot = resetBotForTests();
  const replies = interceptReplies(bot);
  wireTelegram(bot, {
    directory: directoryOf([lead]),
    identity: identityFor(member.userId),
    dayList: memoryDayListStore(),
  });
  await sendStart(bot, telegramUserId);
  expect(replies).toEqual(["Нет доступа"]);
  expect(replies.join("\n")).not.toMatch(leak);
});

it("INV-12: участник проходит, ответ без данных проекта", async () => {
  const bot = resetBotForTests();
  const replies = interceptReplies(bot);
  wireTelegram(bot, {
    directory: directoryOf([lead]),
    identity: identityFor(lead.userId),
    dayList: memoryDayListStore(),
  });
  await sendStart(bot, telegramUserId);
  expect(replies).toEqual(["Выберите экран"]);
  expect(replies.join("\n")).not.toMatch(leak);
});

it("INV-12: grammY-регистрация только через bind.ts", () => {
  const attach = /\.(command|hears|callbackQuery|inlineQuery|on|use)\s*\(/;
  const hits: string[] = [];
  for (const file of listTelegramTs(join(repoRoot, "src/telegram"))) {
    const path = relative(repoRoot, file).replaceAll("\\", "/");
    if (path === "src/telegram/bind.ts") {
      continue;
    }
    if (attach.test(readFileSync(file, "utf8"))) {
      hits.push(path);
    }
  }
  expect(hits).toEqual([]);
  expect(readFileSync(join(repoRoot, "src/telegram/bind.ts"), "utf8")).toContain(
    "registerGuardedHandler",
  );
});
