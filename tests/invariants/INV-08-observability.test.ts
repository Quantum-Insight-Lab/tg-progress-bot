import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { Transformer } from "grammy";
import { constants } from "../../src/config/index.js";
import { resetHandlerRegistry, type ProjectMember } from "../../src/domain/projects/index.js";
import { emit } from "../../src/events/emit.js";
import { EVENT_TYPES } from "../../src/events/generated/index.js";
import { getPool } from "../../src/infrastructure/db.js";
import {
  COVERAGE_GAP_WARNING,
  coverageGapAlertsAtNight,
  coverageGapByProject,
  coverageGapWarns,
  duplicateDeliveries,
  formatGithubDataAge,
  recordDuplicateDelivery,
  recordInvariantViolation,
  recordRejectedCommand,
  recordReportDeliveryFailure,
  recordSchedulerMissedRun,
  rejectedCommands,
  resetGithubSyncForTests,
  resetObservabilityCountersForTests,
  stabilitySnapshot,
  takeDueImmediateAlerts,
} from "../../src/observability/index.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { insertTask, seedProject } from "../helpers/domain-seed.js";
import { memoryDayListStore } from "../helpers/day-list-store.js";
import {
  composeDailyReport,
  resetBotForTests,
  wireTelegram,
} from "../../src/telegram/index.js";
import { dbScreenReader } from "../../src/projections/index.js";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(() => {
  resetHandlerRegistry();
  resetObservabilityCountersForTests();
  resetGithubSyncForTests();
});

it("INV-08: duplicate_deliveries растёт на повтор emit", async () => {
  const key = `dup:${randomUUID()}`;
  const payload = {
    report_type: "daily" as const,
    project_ids: ["p"],
    destination: "dm" as const,
    chat_id: 1,
    topic_id: null,
  };
  const first = await emit(EVENT_TYPES.REPORT_SENT, {
    actor: { id: "system", role: "system" },
    subject: { entity: "ReportTarget", id: randomUUID() },
    payload,
    idempotencyKey: key,
  });
  const second = await emit(EVENT_TYPES.REPORT_SENT, {
    actor: { id: "system", role: "system" },
    subject: { entity: "ReportTarget", id: randomUUID() },
    payload,
    idempotencyKey: key,
  });
  expect(first.applied).toBe(true);
  expect(second.applied).toBe(false);
  expect(duplicateDeliveries()).toBe(1);
});

it("INV-11: coverage_gap выше половины — предупреждение у процента", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  await insertTask(pool, seed);
  await pool.query(
    `INSERT INTO issues (id, project_id, issue_number, title, state)
     VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      seed.projectId,
      9001,
      "Orphan A",
      "open",
      randomUUID(),
      seed.projectId,
      9002,
      "Orphan B",
      "open",
    ],
  );
  const gaps = await coverageGapByProject([seed.projectId]);
  const gap = gaps.get(seed.projectId) ?? null;
  expect(gap).not.toBeNull();
  expect(coverageGapWarns(gap)).toBe(true);
  expect(gap ?? 0).toBeGreaterThan(constants.coverageGapWarnRatio);
  const text = composeDailyReport(
    [
      {
        projectId: seed.projectId,
        name: "P",
        timezone: "Asia/Bangkok",
        today: "2026-09-21",
        previousProgress: null,
        todayClosed: 0,
        todayStarted: 0,
        todayBlocked: 0,
        changed: [],
        risk: null,
        plan: [],
        tasks: [
          {
            id: "t1",
            projectId: seed.projectId,
            title: "Task",
            status: "DONE",
            priority: "normal",
            lastChangeAt: null,
          },
        ],
      },
    ],
    true,
    gaps,
  );
  expect(text).toContain("100%");
  expect(text).toContain(COVERAGE_GAP_WARNING);
});

it("INV-11: coverage_gap не алертит ночью", () => {
  expect(coverageGapAlertsAtNight()).toBe(false);
});

it("INV-12: rejected_commands считает role_denied и not_a_member", () => {
  recordRejectedCommand("role_denied");
  recordRejectedCommand("not_a_member");
  expect(rejectedCommands().role_denied).toBe(1);
  expect(rejectedCommands().not_a_member).toBe(1);
});

it("INV-10: экран GitHub показывает возраст данных", async () => {
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
    id: "m-gh-age",
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
      chat: { id: chatId, type: "group", title: "G" },
      from: { id: telegramUserId, is_bot: false, first_name: "A" },
      text: "/github",
      entities: [{ offset: 0, length: 7, type: "bot_command" }],
    },
  });
  expect(texts.join("\n")).toContain("Данные GitHub: нет");
});

it("алерты: invariant_violations, report_delivery_failures, scheduler_missed_runs — сразу", () => {
  expect(takeDueImmediateAlerts()).toEqual([]);
  recordInvariantViolation();
  recordReportDeliveryFailure("group");
  recordSchedulerMissedRun("daily:group:1:2026-09-21");
  const kinds = takeDueImmediateAlerts().map((alert) => alert.kind);
  expect(kinds).toEqual([
    "invariant_violations",
    "report_delivery_failures",
    "scheduler_missed_runs",
  ]);
  expect(takeDueImmediateAlerts()).toEqual([]);
});

it("github_sync_lag: formatGithubDataAge различает свежие и устаревшие", () => {
  expect(formatGithubDataAge(null, 1000)).toBe("Данные GitHub: нет");
  expect(formatGithubDataAge(0, 1000)).toBe("Данные GitHub: 0 с");
  expect(formatGithubDataAge(1000, 1000)).toBe("Данные GitHub устарели: 1 с");
});

it("дашборд: stabilitySnapshot читает метрики из 08", async () => {
  const snap = await stabilitySnapshot();
  expect(snap.duplicate_deliveries).toBe(0);
  expect(snap.invariant_violations).toBe(0);
  expect(snap.scheduler_missed_runs).toBe(0);
  expect(snap.report_delivery_failures).toEqual({ dm: 0, group: 0 });
  expect(snap.coverage_gap).not.toBeUndefined();
});

it("INV-08: recordDuplicateDelivery увеличивает счётчик", () => {
  recordDuplicateDelivery();
  recordDuplicateDelivery();
  expect(duplicateDeliveries()).toBe(2);
});
