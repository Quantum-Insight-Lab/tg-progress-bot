import { blockersBoard } from "./blockers-board.js";
import { doneFeed } from "./done-feed.js";
import { githubState } from "./github-state.js";
import { workBoard } from "./in-progress-board.js";
import { planQueue } from "./plan-queue.js";
import { projectProgress } from "./project-progress.js";
import { todayList } from "./today-list.js";
import type { ScreenReader } from "./types.js";

export type {
  BlockersCard,
  DeclaredBlockerItem,
  DoneCard,
  GithubCard,
  PlanCard,
  PlanItem,
  ProgressTaskRow,
  ProjectProgressCard,
  ScreenKind,
  ScreenReader,
  StaleBlockerItem,
  WorkCard,
  WorkItem,
} from "./types.js";
export { dayNumberOf } from "./day-number.js";
export type { DayNumberItem } from "./day-number.js";

export {
  blockersBoard,
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
    blockersBoard,
    githubState,
  };
}

export function emptyScreenReader(): ScreenReader {
  return {
    projectProgress: async () => [],
    workBoard: async () => [],
    doneFeed: async () => [],
    planQueue: async () => [],
    blockersBoard: async () => [],
    githubState: async () => [],
  };
}
