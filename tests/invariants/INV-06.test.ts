import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import type { Task, TaskList } from "../../src/domain/tasks/index.js";
import { workBoard } from "../../src/projections/in-progress-board.js";
import { createRuntimeDayList } from "../../src/process/day-list.js";
import { clock } from "../../src/infrastructure/clock.js";
import { getPool } from "../../src/infrastructure/db.js";
import { applyMigrations } from "../../scripts/migrate.js";
import { seedProject } from "../helpers/domain-seed.js";
import { pgCode } from "../helpers/pg-code.js";

beforeAll(async () => {
  await applyMigrations();
});

it("INV-06: на пару проект + дата не больше одного списка", async () => {
  const pool = getPool();
  const seed = await seedProject(pool);
  const day = "2026-09-21";
  await pool.query(
    `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
    [randomUUID(), seed.projectId, day],
  );
  await expect(
    pool.query(
      `INSERT INTO task_lists (id, project_id, list_date) VALUES ($1, $2, $3)`,
      [randomUUID(), seed.projectId, day],
    ),
  ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23505");
});

it("INV-06: записанный список дня виден экрану В работе", async () => {
  const seed = await seedProject(getPool());
  const store = createRuntimeDayList();
  const listDate = clock.calendarDate("Asia/Bangkok");
  const listId = randomUUID();
  const taskId = randomUUID();
  const task: Task = {
    id: taskId,
    projectId: seed.projectId,
    issueId: seed.issueId,
    assigneeId: seed.userId,
    title: "На сегодня",
    status: "IN_PROGRESS",
    priority: "normal",
    createdByUserId: seed.userId,
  };
  const list: TaskList = {
    id: listId,
    projectId: seed.projectId,
    listDate,
    topicId: null,
    messageId: null,
    items: [
      {
        id: randomUUID(),
        projectId: seed.projectId,
        listId,
        taskId,
        position: 1,
        isDone: false,
        carriedFromListId: null,
      },
    ],
  };
  await store.saveTask(task, []);
  await store.saveList(list);

  const reloaded = createRuntimeDayList();
  await reloaded.reload();
  expect(reloaded.taskOf(taskId)?.task.title).toBe("На сегодня");

  const board = await workBoard([seed.projectId]);
  expect(board[0]?.items.map((item) => item.title)).toContain("На сегодня");
});
