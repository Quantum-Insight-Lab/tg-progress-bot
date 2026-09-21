import { clock, type Clock } from "../../src/infrastructure/clock.js";
import type { Blocker, IssueRef, Task, TaskList } from "../../src/domain/tasks/index.js";
import type { DayListStore } from "../../src/telegram/index.js";

export function memoryDayListStore(init?: {
  clock?: Clock;
  timeZone?: string;
  issues?: readonly IssueRef[];
  lists?: TaskList[];
}): DayListStore & {
  lists: TaskList[];
  tasks: Map<string, { task: Task; blockers: Blocker[] }>;
} {
  const lists: TaskList[] = init?.lists === undefined ? [] : [...init.lists];
  const tasks = new Map<string, { task: Task; blockers: Blocker[] }>();
  let nextId = 0;
  return {
    lists,
    tasks,
    clock: init?.clock ?? clock,
    timeZoneOf: () => init?.timeZone ?? "Asia/Bangkok",
    findIssue: (projectId, issueId) => {
      const listed = init?.issues?.find(
        (issue) => issue.id === issueId && issue.projectId === projectId,
      );
      if (listed !== undefined) {
        return listed;
      }
      if (init?.issues !== undefined) {
        return undefined;
      }
      return { id: issueId, projectId };
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
    newId: () => {
      nextId += 1;
      return `id-${String(nextId)}`;
    },
  };
}
