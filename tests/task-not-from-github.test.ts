import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ABSENT_MIRROR_FIELDS,
  assigneeBecomesTask,
  GITHUB_FACT_TYPES,
  SHARED_WITH_GITHUB,
  taskLedByPerson,
  tasksFromGithub,
  type GithubFact,
} from '../src/domain/tasks/github-origin.ts';
import { defineTask } from '../src/domain/tasks/task.ts';
import { TASK_PRIORITY_NORMAL, TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { readEventsMigration, readProjectsMigration, readTasksMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';

const at = '2026-09-28T07:33:00.000Z';
const occurredAt = new Date(at);

const issueFact: GithubFact = {
  type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
  payload: {
    repository_id: 'repo-1',
    issue_number: 40,
    title: 'Классификация сигналов',
    state: 'open',
    state_reason: null,
    assignees: ['andrey'],
    closed_by_login: null,
    updated_at: at,
  },
};

const pullRequestFact: GithubFact = {
  type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
  payload: {
    repository_id: 'repo-1',
    pull_request_number: 7,
    title: 'Черновик карточки',
    state: 'open',
    author_login: 'andrey',
    updated_at: at,
    merged_at: null,
    merged_by_login: null,
  },
};

const commitsFact: GithubFact = {
  type: EVENT_TYPES.GITHUB_COMMITS_PUSHED,
  payload: {
    repository_id: 'repo-1',
    commits: [{ sha: 'abc', author_login: 'andrey', message: 'классификация', created_at: at }],
  },
};

const stream: readonly GithubFact[] = [
  issueFact,
  pullRequestFact,
  commitsFact,
  {
    type: EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED,
    payload: {
      repository_id: 'repo-1',
      branch: 'main',
      is_default_branch: true,
      conclusion: 'success',
      pull_request_numbers: [],
    },
  },
  {
    type: EVENT_TYPES.GITHUB_MILESTONE_CHANGED,
    payload: {
      repository_id: 'repo-1',
      milestone_number: 2,
      title: 'Pilot',
      state: 'open',
      due_on: null,
    },
  },
  {
    type: EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED,
    payload: {
      repository_id: 'repo-1',
      issue_number: 40,
      depends_on_issue_number: 12,
      link_type: 'blocked_by',
      action: 'added',
    },
  },
  {
    type: EVENT_TYPES.GITHUB_RECONCILED,
    payload: { repository_id: 'repo-1', restored_facts: 0 },
  },
  {
    type: EVENT_TYPES.REPO_PR_STALLED,
    payload: { repository_id: 'repo-1', pull_request_number: 7, author_login: 'andrey', days: 2 },
  },
];

function publish(journal: EventJournal, fact: GithubFact): Promise<unknown> {
  const input = {
    source: 'github',
    idempotencyKey: fact.type,
    actor: { id: 'github', role: 'github' },
    subject: { entity: 'Mirror', id: 'repo-1' },
    occurredAt,
    causationId: null,
    correlationId: null,
  };
  switch (fact.type) {
    case EVENT_TYPES.GITHUB_ISSUE_CHANGED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_COMMITS_PUSHED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_MILESTONE_CHANGED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.GITHUB_RECONCILED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    case EVENT_TYPES.REPO_PR_STALLED:
      return emit(journal, { ...input, type: fact.type, payload: fact.payload });
    default: {
      const unreachable: never = fact;
      return unreachable;
    }
  }
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

async function openTasks(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readTasksMigration());
  const db = new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

describe('задача не выводится из GitHub', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-04 поток GitHub задач не создаёт: issue, PR, коммит и assignee; поля issue нет', async () => {
    const registry = (Object.values(EVENT_TYPES) as string[]).filter(
      (type) => type.startsWith('github.') || type === EVENT_TYPES.REPO_PR_STALLED,
    );
    expect([...GITHUB_FACT_TYPES].sort()).toEqual([...registry].sort());
    expect(SHARED_WITH_GITHUB).toEqual(['person', 'project']);
    expect(taskLedByPerson()).toEqual({ place: 'supergroup', source: 'telegram' });
    expect(assigneeBecomesTask(['andrey'])).toBe(false);
    expect(tasksFromGithub(stream)).toEqual([]);
    expect(tasksFromGithub([issueFact, pullRequestFact, commitsFact])).toEqual([]);

    const task = defineTask({
      id: '00000000-0000-4000-8000-0000000000b1',
      projectId: '00000000-0000-4000-8000-000000000010',
      number: 7,
      title: 'Классификация сигнала',
      status: TASK_STATUS_IN_PROGRESS,
      priority: TASK_PRIORITY_NORMAL,
      assigneeId: '00000000-0000-4000-8000-000000000001',
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    for (const field of ABSENT_MIRROR_FIELDS) expect(Object.keys(task)).not.toContain(field);

    const handle = await openTasks();
    opened.push(handle);
    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
    `.execute(handle.db);
    const names = columns.rows.map((row) => row.column_name);
    for (const field of ABSENT_MIRROR_FIELDS) {
      expect(names.filter((name) => name === field || name.startsWith(`${field}_`))).toEqual([]);
    }
    expect(names).not.toContain('repository_id');
    expect(names).not.toContain('github_login');

    const links = await sql<{ column_name: string; foreign_table: string }>`
      SELECT att.attname AS column_name, ref.relname AS foreign_table
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_class AS ref ON ref.oid = con.confrelid
      JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND rel.relname = 'tasks'
    `.execute(handle.db);
    expect(links.rows.map((row) => `${row.column_name}->${row.foreign_table}`).sort()).toEqual([
      'assignee_id->users',
      'project_id->projects',
    ]);

    const journal = createEventJournal(handle.db);
    for (const fact of stream) await publish(journal, fact);
    const tasks = await sql<{ n: number }>`SELECT CAST(count(*) AS int) AS n FROM tasks`.execute(handle.db);
    expect(Number(tasks.rows[0]?.n)).toBe(0);
    const recorded = await sql<{ n: number }>`
      SELECT CAST(count(*) AS int) AS n FROM events WHERE source = 'github'
    `.execute(handle.db);
    expect(Number(recorded.rows[0]?.n)).toBe(stream.length);

    const writers = tsFiles('src').filter((file) => readFileSync(file, 'utf8').includes("insertInto('tasks')"));
    expect(writers).toEqual(['src/infrastructure/tasks.ts']);
    const githubSeesTasks = tsFiles('src/github').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('domain/tasks') || text.includes('infrastructure/tasks');
    });
    expect(githubSeesTasks).toEqual([]);
  });
});
