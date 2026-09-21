import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type Seed = {
  userId: string;
  projectId: string;
  issueId: string;
};

function bigintFromUuid(id: string): string {
  return BigInt("0x" + id.replaceAll("-", "").slice(0, 15)).toString();
}

export async function seedProject(pool: Pool): Promise<Seed> {
  const userId = randomUUID();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const telegramUserId = bigintFromUuid(userId);
  const issueNumber = Number.parseInt(issueId.replaceAll("-", "").slice(0, 7), 16);

  await pool.query(
    "INSERT INTO users (id, telegram_user_id, github_login) VALUES ($1, $2, $3)",
    [userId, telegramUserId, `gh-${userId}`],
  );
  await pool.query(
    `INSERT INTO projects (id, name, repository, timezone, telegram_chat_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, "P", "org/repo", "Asia/Bangkok", telegramUserId],
  );
  await pool.query(
    `INSERT INTO project_members (id, project_id, user_id, role)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), projectId, userId, "member"],
  );
  await pool.query(
    `INSERT INTO issues (id, project_id, issue_number, title, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [issueId, projectId, issueNumber, "Issue", "open"],
  );

  return { userId, projectId, issueId };
}

export async function insertTask(
  pool: Pool,
  seed: Seed,
  taskId = randomUUID(),
): Promise<string> {
  await pool.query(
    `INSERT INTO tasks (id, project_id, issue_id, assignee_id, title, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, seed.projectId, seed.issueId, seed.userId, "Task", "IN_PROGRESS", "normal"],
  );
  return taskId;
}
