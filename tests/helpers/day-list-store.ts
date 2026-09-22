import { randomUUID } from "node:crypto";
import { clock, type Clock } from "../../src/infrastructure/clock.js";
import type { Blocker, MemberRef, Task, TaskList } from "../../src/domain/tasks/index.js";
import type { DayListStore, PendingBlockerAsk, PendingTaskDraft, ProjectIssue } from "../../src/telegram/day-list.js";

export function sampleIssue(projectId: string): ProjectIssue {
  return { id: "issue-1", projectId, number: 1, title: "Issue" };
}

export function memoryDayListStore(init?: {
  clock?: Clock;
  timeZone?: string;
  issues?: readonly ProjectIssue[];
  lists?: TaskList[];
  roster?: readonly MemberRef[];
  leads?: readonly { userId: string; telegramUserId: string }[];
  telegramUsers?: readonly { userId: string; telegramUserId: string }[];
}): DayListStore & {
  lists: TaskList[];
  tasks: Map<string, { task: Task; blockers: Blocker[] }>;
} {
  const lists: TaskList[] = init?.lists === undefined ? [] : [...init.lists];
  const tasks = new Map<string, { task: Task; blockers: Blocker[] }>();
  const leads = init?.leads ?? [];
  const telegramUsers = init?.telegramUsers ?? leads;
  const issues = init?.issues === undefined ? [] : [...init.issues];
  const pending = new Map<string, PendingTaskDraft>();
  const pendingAsks = new Map<string, PendingBlockerAsk>();
  const askedOn = new Map<string, string>();
  return {
    lists,
    tasks,
    clock: init?.clock ?? clock,
    timeZoneOf: () => init?.timeZone ?? "Asia/Bangkok",
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
      tasks.set(task.id, { task, blockers });
    },
    rosterOf: (projectId) =>
      (init?.roster ?? []).filter((member) => member.projectId === projectId),
    leadsOf: () => leads.map((lead) => ({ userId: lead.userId })),
    telegramIdOf: (userId) =>
      telegramUsers.find((entry) => entry.userId === userId)?.telegramUserId ??
      leads.find((lead) => lead.userId === userId)?.telegramUserId,
    projectIdOfItem: (itemId) =>
      lists.find((list) => list.items.some((item) => item.id === itemId))
        ?.projectId,
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
      for (const entry of tasks.values()) {
        if (entry.blockers.some((blocker) => blocker.id === blockerId)) {
          return entry.task.projectId;
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
