import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Transformer } from "grammy";
import { defaultDailyCron, isDailyCronDue, recordReportSent } from "../../src/domain/reports/index.js";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { emit, EVENT_TYPES } from "../../src/events/index.js";
import { createClock } from "../../src/infrastructure/clock.js";
import { getDb, getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject } from "../helpers/domain-seed.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import {
  composeDailyReport,
  dailyReportPollIntervalMs,
  dispatchDueDailyReports,
  resetBotForTests,
  startDailyReportLoop,
  wireTelegram,
} from "../../src/telegram/index.js";
import { dailyDigest } from "../../src/projections/index.js";
import type { DailyProjectSlice } from "../../src/projections/index.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetHandlerRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

it("INV-08: ключ отчёта — report_type + destination + chat_id + period_key", () => {
  const event = recordReportSent({
    targetId: "t1",
    reportType: "daily",
    projectIds: ["p1"],
    destination: "dm",
    chatId: 42,
    topicId: null,
    periodDate: "2026-09-21",
  });
  expect(event.idempotencyKey).toBe("daily:dm:42:2026-09-21");
});

it("INV-08: повтор emit report.sent за тот же период не создаёт второго события", async () => {
  const event = recordReportSent({
    targetId: randomUUID(),
    reportType: "daily",
    projectIds: [randomUUID()],
    destination: "group",
    chatId: Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16),
    topicId: 7,
    periodDate: "2026-09-21",
  });
  const first = await emit(EVENT_TYPES.REPORT_SENT, {
    actor: event.actor,
    subject: event.subject,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
  });
  const second = await emit(EVENT_TYPES.REPORT_SENT, {
    actor: event.actor,
    subject: event.subject,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
  });
  expect(first.applied).toBe(true);
  expect(second.applied).toBe(false);
  expect(second.eventId).toBe(first.eventId);
});

it("INV-08: cron не шлёт повторно в topic за тот же период", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const chatId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
  await pool.query(
    `INSERT INTO report_targets (id, project_id, chat_id, topic_id, report_type, schedule_cron)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), seed.projectId, String(chatId), "15", "daily", defaultDailyCron()],
  );
  const atNine = createClock({
    current: () => new Date("2026-09-21T02:00:00.000Z"),
  });
  expect(isDailyCronDue(defaultDailyCron(), 9, 0)).toBe(true);
  const bot = resetBotForTests();
  const sent: string[] = [];
  const fake: Transformer = (_prev, method, payload) => {
    if (method === "sendMessage" && payload !== undefined && "text" in payload) {
      sent.push(String(payload.text));
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } as never });
  };
  bot.api.config.use(fake);
  await dispatchDueDailyReports(bot, atNine);
  await dispatchDueDailyReports(bot, atNine);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("## DAILY DEVELOPMENT REPORT");
  expect(sent[0]).not.toContain("Все проекты");
  const db = getDb();
  const rows = await db
    .selectFrom("events")
    .select("event_id")
    .where("event_type", "=", EVENT_TYPES.REPORT_SENT)
    .where("idempotency_key", "like", `daily:group:${String(chatId)}:%`)
    .execute();
  expect(rows).toHaveLength(1);
});

it("INV-10: /report в личке — общая строка не сумма процентов, карточка на проект", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  await pool.query(`UPDATE projects SET name = $1 WHERE id = $2`, [
    "Общественный сенсор",
    home.projectId,
  ]);
  const homeDone = await insertTask(pool, home);
  await pool.query(`UPDATE tasks SET status = $1 WHERE id = $2`, ["DONE", homeDone]);
  await insertTask(pool, other);
  await pool.query(
    `INSERT INTO progress_snapshots
      (id, project_id, progress, tasks_total, tasks_done, snapshot_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), home.projectId, 0.37, 2, 1, "2026-09-20", "2026-09-20T00:00:00.000Z"],
  );
  const telegramUserId = Number.parseInt(
    randomUUID().replaceAll("-", "").slice(0, 8),
    16,
  );
  await pool.query(`UPDATE users SET telegram_user_id = $1 WHERE id = $2`, [
    telegramUserId,
    home.userId,
  ]);
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), other.projectId, home.userId, "lead"],
  );
  const member: ProjectMember = {
    id: "m-report",
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
        uid === home.userId && (pid === home.projectId || pid === other.projectId)
          ? { ...member, projectId: pid }
          : undefined,
    },
    identity: {
      findProjectByChatId: () => undefined,
      findUserByTelegramId: (id) =>
        id === String(telegramUserId) ? { id: home.userId } : undefined,
      findProjectIdsByUserId: (uid) =>
        uid === home.userId ? [home.projectId, other.projectId] : [],
    },
    dayList: memoryDayListStore(),
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: telegramUserId, type: "private", first_name: "A" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/report",
      entities: [{ offset: 0, length: 7, type: "bot_command" }],
    },
  });
  const text = texts.join("\n");
  expect(text).toContain("## DAILY DEVELOPMENT REPORT");
  expect(text).toMatch(/\*\*Все проекты:\*\*/);
  expect(text).not.toMatch(/137%/);
  expect(text).toContain("### Общественный сенсор");
  expect(text).toMatch(/\*\*Прогресс:\*\*/);
});

it("INV-10: карточка отчёта не содержит чужой проект; риск из блокера, не вручную", async () => {
  const pool = getPool();
  const home = await seedProject(pool);
  const other = await seedProject(pool);
  const taskId = await insertTask(pool, home);
  await pool.query(`UPDATE tasks SET status = $1, title = $2 WHERE id = $3`, [
    "BLOCKED",
    "AI-12 — Поиск подтверждений",
    taskId,
  ]);
  await pool.query(
    `INSERT INTO blockers (id, task_id, source, signal_type, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), taskId, "signal", "no_check", "один источник данных нестабилен"],
  );
  const otherTask = await insertTask(pool, other);
  await pool.query(`UPDATE tasks SET title = $1 WHERE id = $2`, [
    "Чужая задача",
    otherTask,
  ]);
  const slices = await dailyDigest([home.projectId]);
  const text = composeDailyReport(slices, false);
  expect(text).toContain("**Риск:** один источник данных нестабилен");
  expect(text).not.toContain("Чужая задача");
  expect(slices).toHaveLength(1);
  expect(text).not.toMatch(/риск введен/i);
});

it("INV-11: пустой прогресс в отчёте — «Нет данных», не 0%", () => {
  const text = composeDailyReport(
    [
      {
        projectId: "p",
        name: "Пустой",
        timezone: "Asia/Bangkok",
        today: "2026-09-21",
        tasks: [],
        previousProgress: null,
        todayClosed: 0,
        todayStarted: 0,
        todayBlocked: 0,
        changed: [],
        plan: [],
        risk: null,
      },
    ],
    true,
  );
  expect(text).toContain("**Все проекты:** Нет данных");
  expect(text).toContain("**Прогресс:** Нет данных");
  expect(text).not.toMatch(/\b0%/);
});

it("INV-12: /report без членства — отказ без данных", async () => {
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
    directory: { find: () => undefined },
    identity: {
      findProjectByChatId: () => undefined,
      findUserByTelegramId: () => undefined,
    },
    dayList: memoryDayListStore(),
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 999, type: "private", first_name: "X" },
      from: { id: 999, is_bot: false, first_name: "X" },
      text: "/report",
      entities: [{ offset: 0, length: 7, type: "bot_command" }],
    },
  });
  expect(texts).toEqual(["Нет доступа"]);
  expect(texts.join("\n")).not.toMatch(/DAILY|Прогресс/i);
});

it("INV-10: ежедневный отчёт — поля как в ТЗ §7.1", () => {
  const projectId = "p-sensor";
  const older = "2026-09-21T08:00:00.000Z";
  const slice: DailyProjectSlice = {
    projectId,
    name: "Общественный сенсор",
    timezone: "Asia/Bangkok",
    today: "2026-09-21",
    previousProgress: 0.37,
    todayClosed: 3,
    todayStarted: 2,
    todayBlocked: 1,
    changed: ["AI-классификатор", "обработка voice messages", "PR #138"],
    risk: "один источник данных нестабилен",
    plan: [
      {
        title: "подключить резервный источник",
        priority: "high",
        issueId: "issue-next",
        blockedByOpenIssue: false,
      },
    ],
    tasks: [
      {
        id: "d1",
        projectId,
        title: "a",
        status: "DONE",
        priority: "high",
        lastChangeAt: older,
      },
      {
        id: "d2",
        projectId,
        title: "b",
        status: "DONE",
        priority: "high",
        lastChangeAt: older,
      },
      {
        id: "d3",
        projectId,
        title: "c",
        status: "DONE",
        priority: "low",
        lastChangeAt: older,
      },
      {
        id: "now",
        projectId,
        title: "Verification Engine",
        status: "IN_PROGRESS",
        priority: "high",
        lastChangeAt: "2026-09-21T10:00:00.000Z",
      },
      {
        id: "w1",
        projectId,
        title: "w1",
        status: "IN_PROGRESS",
        priority: "normal",
        lastChangeAt: older,
      },
      {
        id: "w2",
        projectId,
        title: "w2",
        status: "IN_PROGRESS",
        priority: "normal",
        lastChangeAt: older,
      },
      {
        id: "w3",
        projectId,
        title: "w3",
        status: "IN_PROGRESS",
        priority: "normal",
        lastChangeAt: older,
      },
      {
        id: "w4",
        projectId,
        title: "w4",
        status: "IN_PROGRESS",
        priority: "normal",
        lastChangeAt: older,
      },
    ],
  };
  const text = composeDailyReport([slice], true);
  expect(text).toBe(
    [
      "## DAILY DEVELOPMENT REPORT",
      "**Все проекты:** 37% → 39%",
      "",
      "### Общественный сенсор",
      "**Прогресс:** 37% → 39%",
      "**За день:** ✅ закрыто 3 · 🔨 начато 2 · ⚠️ заблокировано 1",
      "**Что изменилось:** AI-классификатор; обработка voice messages; PR #138",
      "**Сейчас:** Verification Engine",
      "**Риск:** один источник данных нестабилен",
      "**Следующий шаг:** подключить резервный источник",
    ].join("\n"),
  );
});

it("C-7: цикл отчёта стартует явно и тикает раз в интервал", async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockResolvedValue(undefined);
  const intervalMs = dailyReportPollIntervalMs();
  const bot = resetBotForTests();
  const stop = startDailyReportLoop({ bot, intervalMs, run });
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(intervalMs - 1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(run).toHaveBeenCalledTimes(2);
});
