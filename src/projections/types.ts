export type ScreenKind = "progress" | "work" | "done" | "plan" | "blockers" | "github";

export type ProgressTaskRow = {
  projectId: string;
  title: string;
  status: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
  priority: "high" | "normal" | "low";
};

export type ProjectProgressCard = {
  projectId: string;
  name: string;
  tasks: ProgressTaskRow[];
  stageName: string | null;
  lastChangeAt: string | null;
  lastChangeLabel: string | null;
};

export type WorkItem = {
  title: string;
  assigneeLogin: string | null;
  dayNumber: number;
  issueNumber: number | null;
  pullRequestNumber: number | null;
};

export type WorkCard = {
  projectId: string;
  name: string;
  items: WorkItem[];
};

export type DoneItem = {
  title: string;
  confirmedLabel: string | null;
  issueNumber: number | null;
  pullRequestNumber: number | null;
};

export type DoneCard = {
  projectId: string;
  name: string;
  items: DoneItem[];
};

export type PlanItem = {
  title: string;
  priority: "high" | "normal" | "low";
  issueId: string;
  blockedByOpenIssue: boolean;
};

export type PlanCard = {
  projectId: string;
  name: string;
  items: PlanItem[];
};

export type GithubCard = {
  projectId: string;
  name: string;
  issuesWithoutTasks: { number: number; title: string }[];
  openPullRequests: { number: number }[];
  failingChecks: { pullRequestNumber: number; conclusion: string }[];
};

export type DeclaredBlockerItem = {
  title: string;
  reason: string;
  waitingIssueTitles: string[];
  requiredAction: string | null;
};

export type StaleBlockerItem = {
  title: string;
  pullRequestNumber: number | null;
  idleDays: number | null;
  ciRed: boolean;
  noBranch: boolean;
  noIssueActivity: boolean;
};

export type BlockersCard = {
  projectId: string;
  name: string;
  declared: DeclaredBlockerItem[];
  stale: StaleBlockerItem[];
};

export type ScreenReader = {
  projectProgress: (projectIds: readonly string[]) => Promise<ProjectProgressCard[]>;
  workBoard: (projectIds: readonly string[]) => Promise<WorkCard[]>;
  doneFeed: (projectIds: readonly string[]) => Promise<DoneCard[]>;
  planQueue: (projectIds: readonly string[]) => Promise<PlanCard[]>;
  blockersBoard: (projectIds: readonly string[]) => Promise<BlockersCard[]>;
  githubState: (projectIds: readonly string[]) => Promise<GithubCard[]>;
};
