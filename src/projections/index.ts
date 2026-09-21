import { doneFeed } from "./done-feed.js";
import { githubState } from "./github-state.js";
import { workBoard } from "./in-progress-board.js";
import { planQueue } from "./plan-queue.js";
import { projectProgress } from "./project-progress.js";
import { todayList } from "./today-list.js";
import type { ScreenReader } from "./types.js";

export type {
  DoneCard,
  GithubCard,
  PlanCard,
  PlanItem,
  ProgressTaskRow,
  ProjectProgressCard,
  ScreenKind,
  ScreenReader,
  WorkCard,
  WorkItem,
} from "./types.js";
export { dayNumberOf } from "./day-number.js";
export type { DayNumberItem } from "./day-number.js";

export {
  doneFeed,
  githubState,
  planQueue,
  projectProgress,
  todayList,
  workBoard,
};

export function dbScreenReader(): ScreenReader {
  return {
    projectProgress,
    workBoard,
    doneFeed,
    planQueue,
    githubState,
  };
}

export function emptyScreenReader(): ScreenReader {
  return {
    projectProgress: async () => [],
    workBoard: async () => [],
    doneFeed: async () => [],
    planQueue: async () => [],
    githubState: async () => [],
  };
}
