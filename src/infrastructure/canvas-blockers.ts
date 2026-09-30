import { sql, type Kysely } from 'kysely';
import { matchesCurrentGithubLogin } from '../domain/shared/github-login-match.ts';
import {
  STALL_LINE_DEFAULT_BRANCH,
  STALL_LINE_PULL_REQUEST,
  type StallLine,
} from '../domain/github/stall.ts';
import { TASK_STATUS_BLOCKED } from '../domain/tasks/status.ts';
import type { Database } from './database.ts';
import { readRepositoryStall } from './pr-stall.ts';

/** Причина открытого блокера его задачи. Пустая — ответа ещё нет. */
export interface CanvasBlockerReason {
  taskNumber: number;
  reason: string | null;
}

/** Строки блока «Блокеры» этого исполнителя. Печать — в проекции. */
export interface CanvasBlockers {
  reasons: readonly CanvasBlockerReason[];
  pullRequests: readonly { pullRequestNumber: number; ciRed: boolean }[];
  defaultBranchCiRed: boolean;
}

interface ReasonRow {
  number: number | string;
  reason: string | null;
}

function taskNumber(value: number | string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new Error('номер задачи повреждён');
}

async function tablePresent(db: Kysely<Database>, table: string): Promise<boolean> {
  const found = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ${table}
  `.execute(db);
  return found.rows.length > 0;
}

async function columnPresent(db: Kysely<Database>, table: string, column: string): Promise<boolean> {
  const found = await sql<{ column_name: string }>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `.execute(db);
  return found.rows.length > 0;
}

/**
 * Причины его задач в `BLOCKED` и строки застоя этого проекта.
 * Чужой автор и другой проект в PR не входят. Красный CI основной ветки — флаг отдельной строки.
 * Задачи и таблица `blockers` здесь не пишутся.
 */
export function selectCanvasBlockers(input: {
  projectId: string;
  githubLogin: string | null;
  reasons: readonly CanvasBlockerReason[];
  lines: readonly StallLine[];
}): CanvasBlockers {
  const projectId = input.projectId.trim();
  const pullRequests: { pullRequestNumber: number; ciRed: boolean }[] = [];
  let defaultBranchCiRed = false;
  for (const line of input.lines) {
    if (line.projectId.trim() !== projectId) continue;
    if (line.kind === STALL_LINE_DEFAULT_BRANCH) {
      defaultBranchCiRed = true;
      continue;
    }
    if (line.kind !== STALL_LINE_PULL_REQUEST) continue;
    if (!matchesCurrentGithubLogin(input.githubLogin, line.authorLogin)) continue;
    pullRequests.push({ pullRequestNumber: line.pullRequestNumber, ciRed: line.ciRed });
  }
  return { reasons: input.reasons, pullRequests, defaultBranchCiRed };
}

async function reasonsOf(db: Kysely<Database>, projectId: string, assigneeId: string): Promise<CanvasBlockerReason[]> {
  if (!(await tablePresent(db, 'blockers'))) return [];
  const found = await sql<ReasonRow>`
    SELECT tasks.number AS number, blockers.reason AS reason
    FROM blockers
    JOIN tasks ON tasks.id = blockers.task_id
    WHERE tasks.project_id = ${projectId}::uuid
      AND tasks.assignee_id = ${assigneeId}::uuid
      AND tasks.status = ${TASK_STATUS_BLOCKED}
      AND blockers.resolved_at IS NULL
    ORDER BY tasks.number, blockers.asked_at
  `.execute(db);
  return found.rows.map((row) => ({ taskNumber: taskNumber(row.number), reason: row.reason }));
}

async function loginOf(db: Kysely<Database>, assigneeId: string): Promise<string | null> {
  if (!(await columnPresent(db, 'users', 'github_login'))) return null;
  const found = await sql<{ github_login: string | null }>`
    SELECT github_login FROM users WHERE id = ${assigneeId}::uuid
  `.execute(db);
  return found.rows[0]?.github_login ?? null;
}

async function mirrorReady(db: Kysely<Database>): Promise<boolean> {
  if (!(await tablePresent(db, 'repositories'))) return false;
  if (!(await tablePresent(db, 'pull_requests'))) return false;
  if (!(await tablePresent(db, 'project_members'))) return false;
  if (!(await columnPresent(db, 'repositories', 'default_branch_ci'))) return false;
  if (!(await columnPresent(db, 'projects', 'repository_id'))) return false;
  if (!(await columnPresent(db, 'users', 'github_login'))) return false;
  if (!(await columnPresent(db, 'pull_requests', 'updated_at'))) return false;
  if (!(await columnPresent(db, 'pull_requests', 'ci_status'))) return false;
  return true;
}

/**
 * Блок «Блокеры» исполнителя на момент показа.
 * Нет таблицы блокеров — причин нет. Нет зеркала — строк CI и PR нет.
 */
export async function loadCanvasBlockers(
  db: Kysely<Database>,
  projectId: string,
  assigneeId: string,
  now: Date,
): Promise<CanvasBlockers> {
  const reasons = await reasonsOf(db, projectId, assigneeId);
  if (!(await mirrorReady(db))) return selectCanvasBlockers({ projectId, githubLogin: null, reasons, lines: [] });
  const facts = await readRepositoryStall(db, now);
  return selectCanvasBlockers({
    projectId,
    githubLogin: await loginOf(db, assigneeId),
    reasons,
    lines: facts.lines,
  });
}
