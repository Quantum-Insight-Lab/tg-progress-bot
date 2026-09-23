import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Blocker, MemberRef, Task, TaskList, TaskListItem } from "../domain/tasks/index.js";
import { clock, type Clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import type {
  DayListStore,
  PendingBlockerAsk,
  PendingTaskDraft,
  ProjectIssue,
} from "../telegram/day-list.js";

async function persistTask(task: Task): Promise<void> {
  await getDb()
    .insertInto("tasks")
    .values({
      id: task.id,
      project_id: task.projectId,
      issue_id: task.issueId,
      assignee_id: task.assigneeId,
      title: task.title,
      status: task.status,
      priority: task.priority,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        assignee_id: task.assigneeId,
        title: task.title,
        status: task.status,
        priority: task.priority,
      }),
    )
    .execute();
}

async function persistList(list: TaskList): Promise<void> {
  const db = getDb();
  await db
    .insertInto("task_lists")
    .values({
      id: list.id,
      project_id: list.projectId,
      list_date: list.listDate,
      topic_id: list.topicId === null ? null : String(list.topicId),
      message_id: list.messageId === null ? null : String(list.messageId),
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        topic_id: list.topicId === null ? null : String(list.topicId),
        message_id: list.messageId === null ? null : String(list.messageId),
      }),
    )
    .execute();
  await db.deleteFrom("task_list_items").where("list_id", "=", list.id).execute();
  if (list.items.length === 0) {
    return;
  }
  await db
    .insertInto("task_list_items")
    .values(
      list.items.map((item) => ({
        id: item.id,
        project_id: item.projectId,
        list_id: item.listId,
        task_id: item.taskId,
        position: item.position,
        is_done: item.isDone,
        carried_from_list_id: item.carriedFromListId,
      })),
    )
    .execute();
}

/** Список дня процесса. Пишется в tasks и task_lists, оттуда его читает экран. */
export function createRuntimeDayList(usedClock: Clock = clock): DayListStore & {
  reload: () => Promise<void>;
} {
  const lists: TaskList[] = [];
  const tasks = new Map<string, { task: Task; blockers: Blocker[] }>();
  const pending = new Map<string, PendingTaskDraft>();
  const pendingAsks = new Map<string, PendingBlockerAsk>();
  const askedOn = new Map<string, string>();
  let issues: ProjectIssue[] = [];
  let roster: MemberRef[] = [];
  let leadRefs: { projectId: string; userId: string }[] = [];
  const telegramIds = new Map<string, string>();
  const timeZones = new Map<string, string>();

  return {
    clock: usedClock,
    async reload() {
      const db = getDb();
      const projectRows = await db
        .selectFrom("projects")
        .select(["id", "timezone"])
        .execute();
      timeZones.clear();
      for (const row of projectRows) {
        timeZones.set(row.id, row.timezone);
      }
      const issueRows = await db
        .selectFrom("issues")
        .select(["id", "project_id", "issue_number", "title", "state"])
        .where("state", "=", "open")
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("issue_pull_requests")
                .select("issue_pull_requests.id")
                .whereRef("issue_pull_requests.project_id", "=", "issues.project_id")
                .whereRef(
                  "issue_pull_requests.pull_request_number",
                  "=",
                  "issues.issue_number",
                ),
            ),
          ),
        )
        .execute();
      issues = issueRows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        number: row.issue_number,
        title: row.title,
      }));
      const memberRows = await db
        .selectFrom("project_members")
        .innerJoin("users", "users.id", "project_members.user_id")
        .select([
          "project_members.project_id as project_id",
          "project_members.user_id as user_id",
          "project_members.role as role",
          "users.telegram_user_id as telegram_user_id",
        ])
        .execute();
      roster = memberRows.map((row) => ({
        projectId: row.project_id,
        userId: row.user_id,
      }));
      leadRefs = memberRows
        .filter((row) => row.role === "lead")
        .map((row) => ({ projectId: row.project_id, userId: row.user_id }));
      telegramIds.clear();
      for (const row of memberRows) {
        telegramIds.set(row.user_id, row.telegram_user_id);
      }
      const taskRows = await db.selectFrom("tasks").selectAll().execute();
      tasks.clear();
      for (const row of taskRows) {
        tasks.set(row.id, {
          task: {
            id: row.id,
            projectId: row.project_id,
            issueId: row.issue_id,
            assigneeId: row.assignee_id,
            title: row.title,
            status: row.status,
            priority: row.priority,
            createdByUserId: row.assignee_id,
          },
          blockers: [],
        });
      }
      const listRows = await db
        .selectFrom("task_lists")
        .select([
          "id",
          "project_id",
          "topic_id",
          "message_id",
          sql<string>`list_date::text`.as("list_date"),
        ])
        .execute();
      const itemRows = await db.selectFrom("task_list_items").selectAll().execute();
      lists.length = 0;
      for (const row of listRows) {
        const items: TaskListItem[] = itemRows
          .filter((item) => item.list_id === row.id)
          .map((item) => ({
            id: item.id,
            projectId: item.project_id,
            listId: item.list_id,
            taskId: item.task_id,
            position: item.position,
            isDone: item.is_done,
            carriedFromListId: item.carried_from_list_id,
          }));
        lists.push({
          id: row.id,
          projectId: row.project_id,
          listDate: row.list_date.slice(0, 10),
          topicId: row.topic_id === null ? null : Number(row.topic_id),
          messageId: row.message_id === null ? null : Number(row.message_id),
          items,
        });
      }
    },
    timeZoneOf: (projectId) => timeZones.get(projectId),
    issuesOf: (projectId) => issues.filter((issue) => issue.projectId === projectId),
    pendingOf: (userId) => pending.get(userId),
    savePendingTask: (draft) => {
      pending.set(draft.userId, draft);
    },
    clearPendingTask: (userId) => {
      pending.delete(userId);
    },
    listsOf: (projectId) => lists.filter((list) => list.projectId === projectId),
    saveList: async (list) => {
      const index = lists.findIndex((entry) => entry.id === list.id);
      if (index === -1) {
        lists.push(list);
      } else {
        lists[index] = list;
      }
      await persistList(list);
    },
    taskOf: (taskId) => tasks.get(taskId),
    saveTask: async (task, blockers) => {
      tasks.set(task.id, { task, blockers: [...blockers] });
      await persistTask(task);
    },
    rosterOf: (projectId) => roster.filter((member) => member.projectId === projectId),
    leadsOf: (projectId) =>
      leadRefs
        .filter((lead) => lead.projectId === projectId)
        .map((lead) => ({ userId: lead.userId })),
    telegramIdOf: (userId) => telegramIds.get(userId),
    projectIdOfItem: (itemId) => {
      for (const list of lists) {
        if (list.items.some((item) => item.id === itemId)) {
          return list.projectId;
        }
      }
      return undefined;
    },
    pendingAskOf: (userId) => pendingAsks.get(userId),
    savePendingAsk: (userId, ask) => {
      pendingAsks.set(userId, ask);
    },
    clearPendingAsk: (userId) => {
      pendingAsks.delete(userId);
    },
    lastAskedOn: (taskId) => askedOn.get(taskId) ?? null,
    markAsked: (taskId, onDate) => {
      askedOn.set(taskId, onDate);
    },
    projectIdOfBlocker: (blockerId) => {
      for (const loaded of tasks.values()) {
        if (loaded.blockers.some((blocker) => blocker.id === blockerId)) {
          return loaded.task.projectId;
        }
      }
      for (const ask of pendingAsks.values()) {
        if (ask.blockerId === blockerId) {
          return ask.projectId;
        }
      }
      return undefined;
    },
    newId: () => randomUUID(),
  };
}
