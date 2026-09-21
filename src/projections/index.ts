import { blockersBoard } from "./blockers-board.js";
import { dailyDigest } from "./daily-digest.js";
import { doneFeed } from "./done-feed.js";
import { githubState } from "./github-state.js";
import { workBoard } from "./in-progress-board.js";
import { planQueue } from "./plan-queue.js";
import { projectProgress } from "./project-progress.js";
import { reportTargets } from "./report-targets.js";
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
export type { DailyProjectSlice, DigestTask } from "./daily-digest.js";
export { dayNumberOf } from "./day-number.js";
export type { DayNumberItem } from "./day-number.js";

export {
  blockersBoard,
  dailyDigest,
  doneFeed,
  githubState,
  planQueue,
  projectProgress,
  reportTargets,
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
