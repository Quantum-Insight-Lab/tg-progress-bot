import { randomUUID } from "node:crypto";
import type { Blocker, MemberRef, Task, TaskList } from "../domain/tasks/index.js";
import { clock, type Clock } from "../infrastructure/clock.js";
import { getDb } from "../infrastructure/db.js";
import type {
  DayListStore,
  PendingBlockerAsk,
  PendingTaskDraft,
  ProjectIssue,
} from "../telegram/day-list.js";

/** Список дня процесса. Задачи живут в памяти: в таблице нет created_by. */
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
    saveList: (list) => {
      const index = lists.findIndex((entry) => entry.id === list.id);
      if (index === -1) {
        lists.push(list);
        return;
      }
      lists[index] = list;
    },
    taskOf: (taskId) => tasks.get(taskId),
    saveTask: (task, blockers) => {
      tasks.set(task.id, { task, blockers: [...blockers] });
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
