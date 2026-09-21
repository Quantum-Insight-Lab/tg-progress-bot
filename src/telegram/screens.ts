import type { Context } from "grammy";
import {
  formatProgress,
  progressOfProject,
  type ProgressTask,
} from "../domain/progress/index.js";
import {
  requireMember,
  type MemberDirectory,
  type ProjectAccess,
  type ProjectMember,
} from "../domain/projects/index.js";
import { weightOf } from "../domain/tasks/index.js";
import type { ScreenKind, ScreenReader } from "../projections/index.js";
import {
  SCREEN_CALLBACK_PREFIX,
  SCREEN_MENU_PROMPT,
  screensKeyboard,
} from "./callbacks.js";

export type ScreenIdentity = {
  findProjectIdsByUserId?: ((userId: string) => readonly string[]) | undefined;
};

function percentLabel(value: number | null): string {
  if (value === null) {
    return formatProgress(null);
  }
  return `${String(Math.round(value * 100))}%`;
}

function countsOf(tasks: readonly ProgressTask[]): {
  done: number;
  work: number;
  blocked: number;
  planned: number;
} {
  return {
    done: tasks.filter((task) => task.status === "DONE").length,
    work: tasks.filter(
      (task) => task.status === "IN_PROGRESS" || task.status === "REVIEW",
    ).length,
    blocked: tasks.filter((task) => task.status === "BLOCKED").length,
    planned: tasks.filter((task) => task.status === "PLANNED").length,
  };
}

function nowTitleOf(
  tasks: readonly { title: string; status: ProgressTask["status"]; priority: ProgressTask["priority"] }[],
): string | null {
  const active = tasks
    .filter((task) => task.status === "IN_PROGRESS" || task.status === "REVIEW")
    .sort((left, right) => weightOf(right.priority) - weightOf(left.priority));
  return active[0]?.title ?? null;
}

function nextTitleOf(
  items: readonly { title: string; priority: ProgressTask["priority"]; blockedByOpenIssue: boolean }[],
): string | null {
  const ordered = [...items].sort((left, right) => {
    if (left.blockedByOpenIssue !== right.blockedByOpenIssue) {
      return left.blockedByOpenIssue ? 1 : -1;
    }
    return weightOf(right.priority) - weightOf(left.priority);
  });
  return ordered.find((item) => !item.blockedByOpenIssue)?.title ?? null;
}

export function projectIdsForScreen(
  access: ProjectAccess,
  directory: MemberDirectory,
  identity: ScreenIdentity,
): string[] {
  const requested = identity.findProjectIdsByUserId?.(access.userId) ?? [
    access.projectId,
  ];
  const allowed = requested.filter(
    (projectId) => directory.find(projectId, access.userId) !== undefined,
  );
  if (allowed.length === 0) {
    requireMember(undefined);
  }
  return allowed;
}

function byLastChange(
  left: { lastChangeAt: string | null },
  right: { lastChangeAt: string | null },
): number {
  if (left.lastChangeAt === null && right.lastChangeAt === null) {
    return 0;
  }
  if (left.lastChangeAt === null) {
    return 1;
  }
  if (right.lastChangeAt === null) {
    return -1;
  }
  return right.lastChangeAt.localeCompare(left.lastChangeAt);
}

function renderProgress(
  cards: Awaited<ReturnType<ScreenReader["projectProgress"]>>,
  plans: Awaited<ReturnType<ScreenReader["planQueue"]>>,
): string {
  return [...cards]
    .sort(byLastChange)
    .map((card) => {
      const tasks: ProgressTask[] = card.tasks;
      const progress = progressOfProject(card.projectId, tasks);
      const counts = countsOf(tasks);
      const plan = plans.find((entry) => entry.projectId === card.projectId);
      const lines = [
        card.name,
        percentLabel(progress),
      ];
      if (card.stageName !== null) {
        lines.push(card.stageName);
      }
      lines.push(
        `выполнено ${String(counts.done)}, в работе ${String(counts.work)}, заблокировано ${String(counts.blocked)}, запланировано ${String(counts.planned)}`,
      );
      if (card.lastChangeLabel !== null) {
        lines.push(`Последнее изменение: ${card.lastChangeLabel}`);
      }
      const now = nowTitleOf(card.tasks);
      if (now !== null) {
        lines.push(`Сейчас: ${now}`);
      }
      const next = nextTitleOf(plan?.items ?? []);
      if (next !== null) {
        lines.push(`Следующий шаг: ${next}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderWork(cards: Awaited<ReturnType<ScreenReader["workBoard"]>>): string {
  return cards
    .map((card) => {
      const lines = [card.name];
      for (const item of card.items) {
        const bits: string[] = [];
        if (item.assigneeLogin !== null) {
          bits.push(item.assigneeLogin);
        }
        if (item.dayNumber > 1) {
          bits.push(`день ${String(item.dayNumber)}`);
        }
        let head = item.title;
        if (bits.length > 0) {
          head += ` — ${bits.join(", ")}`;
        }
        lines.push(head);
        const refs: string[] = [];
        if (item.issueNumber !== null) {
          refs.push(`Issue #${String(item.issueNumber)}`);
        }
        if (item.pullRequestNumber !== null) {
          refs.push(`PR #${String(item.pullRequestNumber)}`);
        }
        if (refs.length > 0) {
          lines.push(refs.join(", "));
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderDone(cards: Awaited<ReturnType<ScreenReader["doneFeed"]>>): string {
  return cards
    .map((card) => {
      const lines = [card.name];
      for (const item of card.items) {
        let line = `✅ ${item.title}`;
        if (item.confirmedLabel !== null) {
          line += ` — подтверждено ${item.confirmedLabel}`;
        }
        lines.push(line);
        const refs: string[] = [];
        if (item.issueNumber !== null) {
          refs.push(`Issue #${String(item.issueNumber)}`);
        }
        if (item.pullRequestNumber !== null) {
          refs.push(`PR #${String(item.pullRequestNumber)}`);
        }
        if (refs.length > 0) {
          lines.push(refs.join(", "));
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderPlan(cards: Awaited<ReturnType<ScreenReader["planQueue"]>>): string {
  return cards
    .map((card) => {
      const ordered = [...card.items].sort((left, right) => {
        if (left.blockedByOpenIssue !== right.blockedByOpenIssue) {
          return left.blockedByOpenIssue ? 1 : -1;
        }
        return weightOf(right.priority) - weightOf(left.priority);
      });
      const lines = [card.name];
      for (const item of ordered) {
        lines.push(item.title);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderGithub(cards: Awaited<ReturnType<ScreenReader["githubState"]>>): string {
  return cards
    .map((card) => {
      const lines = [card.name];
      if (card.issuesWithoutTasks.length > 0) {
        lines.push("Issues без задач:");
        for (const issue of card.issuesWithoutTasks) {
          lines.push(`#${String(issue.number)} ${issue.title}`);
        }
      }
      for (const pull of card.openPullRequests) {
        lines.push(`PR #${String(pull.number)}`);
      }
      for (const check of card.failingChecks) {
        lines.push(`CI PR #${String(check.pullRequestNumber)} ${check.conclusion}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function onStartMenu(ctx: Context): Promise<void> {
  await ctx.reply(SCREEN_MENU_PROMPT, { reply_markup: screensKeyboard() });
}

export async function onScreenCallback(
  ctx: Context,
  access: ProjectAccess,
  _member: ProjectMember,
  directory: MemberDirectory,
  identity: ScreenIdentity,
  screens: ScreenReader,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const kind = data?.startsWith(SCREEN_CALLBACK_PREFIX)
    ? (data.slice(SCREEN_CALLBACK_PREFIX.length) as ScreenKind)
    : undefined;
  await showScreen(ctx, access, directory, identity, screens, kind);
  await ctx.answerCallbackQuery();
}

export async function onScreenCommand(
  ctx: Context,
  access: ProjectAccess,
  _member: ProjectMember,
  directory: MemberDirectory,
  identity: ScreenIdentity,
  screens: ScreenReader,
  kind: ScreenKind,
): Promise<void> {
  await showScreen(ctx, access, directory, identity, screens, kind);
}

async function showScreen(
  ctx: Context,
  access: ProjectAccess,
  directory: MemberDirectory,
  identity: ScreenIdentity,
  screens: ScreenReader,
  kind: ScreenKind | undefined,
): Promise<void> {
  if (kind === undefined) {
    await ctx.reply(SCREEN_MENU_PROMPT, { reply_markup: screensKeyboard() });
    return;
  }
  const projectIds = projectIdsForScreen(access, directory, identity);
  let text: string;
  if (kind === "progress") {
    const [cards, plans] = await Promise.all([
      screens.projectProgress(projectIds),
      screens.planQueue(projectIds),
    ]);
    text = renderProgress(cards, plans);
  } else if (kind === "work") {
    text = renderWork(await screens.workBoard(projectIds));
  } else if (kind === "done") {
    text = renderDone(await screens.doneFeed(projectIds));
  } else if (kind === "plan") {
    text = renderPlan(await screens.planQueue(projectIds));
  } else {
    text = renderGithub(await screens.githubState(projectIds));
  }
  if (text.length === 0) {
    text = formatProgress(null);
  }
  await ctx.reply(text);
}
