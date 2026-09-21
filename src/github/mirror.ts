import { randomUUID } from "node:crypto";
import { getDb } from "../infrastructure/db.js";
import type { ParsedGithubFact } from "./parse.js";

export async function idOfIssue(
  projectId: string,
  issueNumber: number,
): Promise<string> {
  const row = await getDb()
    .selectFrom("issues")
    .select("id")
    .where("project_id", "=", projectId)
    .where("issue_number", "=", issueNumber)
    .executeTakeFirst();
  return row?.id ?? randomUUID();
}

export async function idOfStage(
  projectId: string,
  milestoneNumber: number,
): Promise<string> {
  const row = await getDb()
    .selectFrom("stages")
    .select("id")
    .where("project_id", "=", projectId)
    .where("milestone_number", "=", milestoneNumber)
    .executeTakeFirst();
  return row?.id ?? randomUUID();
}

export async function idOfPullRequest(
  projectId: string,
  pullRequestNumber: number,
): Promise<string> {
  const row = await getDb()
    .selectFrom("issue_pull_requests")
    .select("id")
    .where("project_id", "=", projectId)
    .where("pull_request_number", "=", pullRequestNumber)
    .executeTakeFirst();
  return row?.id ?? randomUUID();
}

export async function persistGithubFact(
  projectId: string,
  fact: ParsedGithubFact,
  ids: {
    issueId?: string | undefined;
    dependsOnIssueId?: string | undefined;
    pullRequestId?: string | undefined;
    stageId?: string | undefined;
    checkRunId?: string | undefined;
  },
): Promise<void> {
  const db = getDb();

  if (fact.kind === "issue_updated") {
    let stageId: string | null = null;
    if (fact.milestone !== null && ids.stageId !== undefined) {
      const milestone = fact.milestone;
      await db
        .insertInto("stages")
        .values({
          id: ids.stageId,
          project_id: projectId,
          milestone_number: milestone.number,
          name: milestone.title,
          sort_order: milestone.number,
          status: milestone.state,
          due_on: milestone.dueOn,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "milestone_number"]).doUpdateSet({
            name: milestone.title,
            sort_order: milestone.number,
            status: milestone.state,
            due_on: milestone.dueOn,
          }),
        )
        .execute();
      const saved = await db
        .selectFrom("stages")
        .select("id")
        .where("project_id", "=", projectId)
        .where("milestone_number", "=", milestone.number)
        .executeTakeFirst();
      stageId = saved?.id ?? ids.stageId;
    }
    if (ids.issueId === undefined) {
      return;
    }
    await db
      .insertInto("issues")
      .values({
        id: ids.issueId,
        project_id: projectId,
        issue_number: fact.issueNumber,
        title: fact.title,
        state: fact.state,
        assignee_login: fact.assigneeLogin,
        stage_id: stageId,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "issue_number"]).doUpdateSet({
          title: fact.title,
          state: fact.state,
          assignee_login: fact.assigneeLogin,
          stage_id: stageId,
        }),
      )
      .execute();
    return;
  }

  if (fact.kind === "issue_linked") {
    if (ids.issueId === undefined || ids.dependsOnIssueId === undefined) {
      return;
    }
    await upsertStubIssue(projectId, ids.issueId, fact.parent);
    await upsertStubIssue(projectId, ids.dependsOnIssueId, fact.child);
    if (fact.removed) {
      await db
        .deleteFrom("issue_dependencies")
        .where("issue_id", "=", ids.issueId)
        .where("depends_on_issue_id", "=", ids.dependsOnIssueId)
        .where("link_type", "=", fact.linkType)
        .execute();
      return;
    }
    await db
      .insertInto("issue_dependencies")
      .values({
        issue_id: ids.issueId,
        depends_on_issue_id: ids.dependsOnIssueId,
        link_type: fact.linkType,
      })
      .onConflict((oc) =>
        oc.columns(["issue_id", "depends_on_issue_id", "link_type"]).doNothing(),
      )
      .execute();
    return;
  }

  if (fact.kind === "pull_request_updated") {
    if (ids.pullRequestId === undefined) {
      return;
    }
    const linkedIssue =
      ids.issueId ??
      (
        await db
          .selectFrom("issues")
          .select("id")
          .where("project_id", "=", projectId)
          .where("issue_number", "=", fact.pullRequestNumber)
          .executeTakeFirst()
      )?.id ??
      null;
    await db
      .insertInto("issue_pull_requests")
      .values({
        id: ids.pullRequestId,
        project_id: projectId,
        pull_request_number: fact.pullRequestNumber,
        issue_id: linkedIssue,
        state: fact.state,
        merged_at: fact.state === "merged" ? fact.updatedAt : null,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "pull_request_number"]).doUpdateSet({
          issue_id: linkedIssue,
          state: fact.state,
          merged_at: fact.state === "merged" ? fact.updatedAt : null,
        }),
      )
      .execute();
    return;
  }

  if (fact.kind === "checks_failed") {
    if (ids.pullRequestId === undefined || ids.checkRunId === undefined) {
      return;
    }
    await db
      .insertInto("issue_pull_requests")
      .values({
        id: ids.pullRequestId,
        project_id: projectId,
        pull_request_number: fact.pullRequestNumber,
        issue_id: null,
        state: "open",
        merged_at: null,
      })
      .onConflict((oc) => oc.columns(["project_id", "pull_request_number"]).doNothing())
      .execute();
    const pr = await db
      .selectFrom("issue_pull_requests")
      .select("id")
      .where("project_id", "=", projectId)
      .where("pull_request_number", "=", fact.pullRequestNumber)
      .executeTakeFirst();
    if (pr === undefined) {
      return;
    }
    await db
      .insertInto("check_runs")
      .values({
        id: ids.checkRunId,
        pull_request_id: pr.id,
        status: "completed",
        conclusion: fact.conclusion,
        completed_at: fact.completedAt,
      })
      .execute();
    return;
  }

  if (ids.stageId === undefined) {
    return;
  }
  await db
    .insertInto("stages")
    .values({
      id: ids.stageId,
      project_id: projectId,
      milestone_number: fact.milestoneNumber,
      name: fact.title,
      sort_order: fact.milestoneNumber,
      status: fact.state,
      due_on: fact.dueOn,
    })
    .onConflict((oc) =>
      oc.columns(["project_id", "milestone_number"]).doUpdateSet({
        name: fact.title,
        sort_order: fact.milestoneNumber,
        status: fact.state,
        due_on: fact.dueOn,
      }),
    )
    .execute();
}

async function upsertStubIssue(
  projectId: string,
  issueId: string,
  issue: { number: number; title: string; state: "open" | "closed" },
): Promise<void> {
  await getDb()
    .insertInto("issues")
    .values({
      id: issueId,
      project_id: projectId,
      issue_number: issue.number,
      title: issue.title,
      state: issue.state,
      assignee_login: null,
      stage_id: null,
    })
    .onConflict((oc) => oc.columns(["project_id", "issue_number"]).doNothing())
    .execute();
}

function stamp(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.toISOString();
}

export async function mirrorMatches(
  projectId: string,
  fact: ParsedGithubFact,
): Promise<boolean> {
  const db = getDb();

  if (fact.kind === "issue_updated") {
    const row = await db
      .selectFrom("issues")
      .select(["title", "state", "assignee_login", "stage_id"])
      .where("project_id", "=", projectId)
      .where("issue_number", "=", fact.issueNumber)
      .executeTakeFirst();
    if (row === undefined) {
      return false;
    }
    if (
      row.title !== fact.title ||
      row.state !== fact.state ||
      (row.assignee_login ?? null) !== fact.assigneeLogin
    ) {
      return false;
    }
    if (fact.milestone === null) {
      return row.stage_id === null;
    }
    const stage = await db
      .selectFrom("stages")
      .select(["id", "name", "status", "due_on"])
      .where("project_id", "=", projectId)
      .where("milestone_number", "=", fact.milestone.number)
      .executeTakeFirst();
    if (stage === undefined || row.stage_id !== stage.id) {
      return false;
    }
    return (
      stage.name === fact.milestone.title &&
      stage.status === fact.milestone.state &&
      stamp(stage.due_on) === fact.milestone.dueOn
    );
  }

  if (fact.kind === "issue_linked") {
    const parent = await db
      .selectFrom("issues")
      .select("id")
      .where("project_id", "=", projectId)
      .where("issue_number", "=", fact.issueNumber)
      .executeTakeFirst();
    const child = await db
      .selectFrom("issues")
      .select("id")
      .where("project_id", "=", projectId)
      .where("issue_number", "=", fact.dependsOnIssueNumber)
      .executeTakeFirst();
    if (parent === undefined || child === undefined) {
      return fact.removed;
    }
    const link = await db
      .selectFrom("issue_dependencies")
      .select("link_type")
      .where("issue_id", "=", parent.id)
      .where("depends_on_issue_id", "=", child.id)
      .where("link_type", "=", fact.linkType)
      .executeTakeFirst();
    if (fact.removed) {
      return link === undefined;
    }
    return link !== undefined;
  }

  if (fact.kind === "pull_request_updated") {
    const row = await db
      .selectFrom("issue_pull_requests")
      .select("state")
      .where("project_id", "=", projectId)
      .where("pull_request_number", "=", fact.pullRequestNumber)
      .executeTakeFirst();
    return row?.state === fact.state;
  }

  if (fact.kind === "checks_failed") {
    const row = await db
      .selectFrom("check_runs")
      .innerJoin(
        "issue_pull_requests",
        "issue_pull_requests.id",
        "check_runs.pull_request_id",
      )
      .select([
        "check_runs.conclusion as conclusion",
        "check_runs.completed_at as completed_at",
      ])
      .where("issue_pull_requests.project_id", "=", projectId)
      .where(
        "issue_pull_requests.pull_request_number",
        "=",
        fact.pullRequestNumber,
      )
      .where("check_runs.conclusion", "=", fact.conclusion)
      .execute();
    return row.some((entry) => stamp(entry.completed_at) === fact.completedAt);
  }

  const stage = await db
    .selectFrom("stages")
    .select(["name", "status", "due_on"])
    .where("project_id", "=", projectId)
    .where("milestone_number", "=", fact.milestoneNumber)
    .executeTakeFirst();
  if (stage === undefined) {
    return false;
  }
  return (
    stage.name === fact.title &&
    stage.status === fact.state &&
    stamp(stage.due_on) === fact.dueOn
  );
}
