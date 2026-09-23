import { z } from "zod";

const repoSchema = z.object({ full_name: z.string().min(1) });

const milestoneSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  due_on: z.string().nullable().optional(),
});

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  assignee: z.object({ login: z.string() }).nullable().optional(),
  milestone: milestoneSchema.nullable().optional(),
});

const pullRequestSchema = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string(),
});

const failingConclusions = ["failure", "timed_out", "cancelled"] as const;
type FailingConclusion = (typeof failingConclusions)[number];

function isFailingConclusion(value: string): value is FailingConclusion {
  return (failingConclusions as readonly string[]).includes(value);
}

function issueState(
  state: "open" | "closed",
  stateReason: string | null | undefined,
): "open" | "closed" | "not_planned" {
  if (state === "open") {
    return "open";
  }
  if (stateReason === "not_planned") {
    return "not_planned";
  }
  return "closed";
}

function prState(pr: z.infer<typeof pullRequestSchema>): "open" | "closed" | "merged" {
  if (pr.merged === true || (pr.merged_at !== null && pr.merged_at !== undefined)) {
    return "merged";
  }
  if (pr.state === "open") {
    return "open";
  }
  return "closed";
}

function firstPrNumber(
  items: readonly { number?: number }[] | undefined,
): number | undefined {
  const first = items?.[0];
  return first?.number;
}

export type ParsedGithubFact =
  | {
      kind: "issue_updated";
      repository: string;
      issueNumber: number;
      title: string;
      state: "open" | "closed" | "not_planned";
      assigneeLogin: string | null;
      milestoneNumber: number | null;
      milestone: {
        number: number;
        title: string;
        state: "open" | "closed";
        dueOn: string | null;
      } | null;
    }
  | {
      kind: "issue_linked";
      repository: string;
      issueNumber: number;
      dependsOnIssueNumber: number;
      linkType: "blocked_by" | "sub_issue";
      removed: boolean;
      parent: { number: number; title: string; state: "open" | "closed" };
      child: { number: number; title: string; state: "open" | "closed" };
    }
  | {
      kind: "pull_request_updated";
      repository: string;
      pullRequestNumber: number;
      state: "open" | "closed" | "merged";
      updatedAt: string;
    }
  | {
      kind: "checks_failed";
      repository: string;
      pullRequestNumber: number;
      conclusion: FailingConclusion;
      completedAt: string;
    }
  | {
      kind: "milestone_updated";
      repository: string;
      milestoneNumber: number;
      title: string;
      state: "open" | "closed";
      dueOn: string | null;
    };

export function parseGithubFact(
  eventName: string,
  body: unknown,
): ParsedGithubFact | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const repo = repoSchema.safeParse(record["repository"]);
  if (!repo.success) {
    return undefined;
  }
  const repository = repo.data.full_name;

  if (eventName === "issues") {
    const rawIssue = record["issue"];
    if (
      typeof rawIssue === "object" &&
      rawIssue !== null &&
      "pull_request" in rawIssue
    ) {
      return undefined;
    }
    const issue = issueSchema.safeParse(rawIssue);
    if (!issue.success) {
      return undefined;
    }
    const milestone = issue.data.milestone ?? null;
    return {
      kind: "issue_updated",
      repository,
      issueNumber: issue.data.number,
      title: issue.data.title,
      state: issueState(issue.data.state, issue.data.state_reason),
      assigneeLogin: issue.data.assignee?.login ?? null,
      milestoneNumber: milestone?.number ?? null,
      milestone:
        milestone === null
          ? null
          : {
              number: milestone.number,
              title: milestone.title,
              state: milestone.state,
              dueOn: milestone.due_on ?? null,
            },
    };
  }

  if (eventName === "sub_issues") {
    const parent = issueSchema.safeParse(record["parent_issue"]);
    const child = issueSchema.safeParse(record["sub_issue"]);
    if (!parent.success || !child.success) {
      return undefined;
    }
    const action = record["action"];
    return {
      kind: "issue_linked",
      repository,
      issueNumber: parent.data.number,
      dependsOnIssueNumber: child.data.number,
      linkType: "sub_issue",
      removed: action === "removed",
      parent: {
        number: parent.data.number,
        title: parent.data.title,
        state: parent.data.state,
      },
      child: {
        number: child.data.number,
        title: child.data.title,
        state: child.data.state,
      },
    };
  }

  if (eventName === "pull_request") {
    const pr = pullRequestSchema.safeParse(record["pull_request"]);
    if (!pr.success) {
      return undefined;
    }
    return {
      kind: "pull_request_updated",
      repository,
      pullRequestNumber: pr.data.number,
      state: prState(pr.data),
      updatedAt: pr.data.updated_at,
    };
  }

  if (eventName === "check_run") {
    const check = record["check_run"];
    if (typeof check !== "object" || check === null) {
      return undefined;
    }
    const run = check as Record<string, unknown>;
    const conclusion = run["conclusion"];
    if (typeof conclusion !== "string" || !isFailingConclusion(conclusion)) {
      return undefined;
    }
    const prs = run["pull_requests"];
    const pullRequestNumber = firstPrNumber(
      Array.isArray(prs) ? (prs as { number?: number }[]) : undefined,
    );
    if (pullRequestNumber === undefined) {
      return undefined;
    }
    const completedAt =
      typeof run["completed_at"] === "string" ? run["completed_at"] : undefined;
    if (completedAt === undefined) {
      return undefined;
    }
    return {
      kind: "checks_failed",
      repository,
      pullRequestNumber,
      conclusion,
      completedAt,
    };
  }

  if (eventName === "milestone") {
    const milestone = milestoneSchema.safeParse(record["milestone"]);
    if (!milestone.success) {
      return undefined;
    }
    return {
      kind: "milestone_updated",
      repository,
      milestoneNumber: milestone.data.number,
      title: milestone.data.title,
      state: milestone.data.state,
      dueOn: milestone.data.due_on ?? null,
    };
  }

  return undefined;
}
