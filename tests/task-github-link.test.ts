import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../src/domain/shared/errors.ts';
import { createTask, TASK_ASSIGNEE_MEMBER, TASK_TOPIC_CHAT, type TaskStore, type TopicOwner } from '../src/domain/tasks/create-task.ts';
import {
  ABSENT_EXTERNAL_KEYS,
  ABSENT_TASK_MEASURES,
  acceptedTaskText,
  defineUnlinked,
  linkFromTitle,
  milestoneAsTaskStatus,
  taskApartFromMilestone,
  tasksBlock,
} from '../src/domain/tasks/github-link.ts';
import { TASK_STATUS_DONE, TASK_STATUS_IN_PROGRESS, TASK_STATUSES, taskStatus } from '../src/domain/tasks/status.ts';
import { defineTask, type Task } from '../src/domain/tasks/task.ts';
import { EVENT_TYPES, TaskCreatedPayloadSchema, type EventJournal, type EventRow } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { readEventsMigration, readProjectsMigration, readTasksMigration, readUsersMigration } from '../src/infrastructure/migrate.ts';
import { parseTaskCommand } from '../src/telegram/task-command.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const at = '2026-09-28T07:33:00.000Z';
const projectId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';
const formulation = 'Смотри https://github.com/org/repo/issues/12 и PR #7';

const openTask: Task = defineTask({
  id: '00000000-0000-4000-8000-0000000000b1',
  projectId,
  number: 7,
  title: formulation,
  status: TASK_STATUS_IN_PROGRESS,
  priority: 'normal',
  assigneeId: userId,
  createdAt: at,
  updatedAt: at,
  completedAt: null,
});

function memoryJournal(): { journal: EventJournal; rows: EventRow[] } {
  const rows: EventRow[] = [];
  return {
    rows,
    journal: {
      async append(row) {
        rows.push(row);
        return { inserted: true, row };
      },
      refuse: () => undefined,
    },
  };
}

function fakeStore(owners: TopicOwner[]): { store: TaskStore; tasks: Task[] } {
  const tasks: Task[] = [];
  return {
    tasks,
    store: {
      async ownersOfTopic() {
        return owners;
      },
      async nextNumber() {
        return 1;
      },
      async insert(task) {
        tasks.push(task);
      },
    },
  };
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

async function openTasks(): Promise<Kysely<Database>> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readTasksMigration());
  return new Kysely<Database>({
    dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }),
  });
}

describe('задача не связана с GitHub ни текстом, ни ключом', () => {
  it('INV-04 номер issue или PR в названии связью не считается, текст в ссылку не разбирается', async () => {
    const accepted = acceptedTaskText(`  ${formulation}  `);
    expect(accepted).toEqual({ title: formulation, githubLink: null, issueStep: null });
    expect(linkFromTitle(formulation)).toBeNull();
    expect(linkFromTitle('#12')).toBeNull();
    expect(linkFromTitle('https://github.com/org/repo/pull/7')).toBeNull();
    expect(parseTaskCommand(`/task ${formulation}`)).toBe(formulation);
    expect(parseTaskCommand('/task #12')).toBe('#12');

    const owner: TopicOwner = { projectId, userId, name: 'Альфа', role: TASK_ASSIGNEE_MEMBER };
    const placed = fakeStore([owner]);
    const journal = memoryJournal();
    const created = await createTask(placed.store, journal.journal, clock, {
      id: openTask.id,
      title: formulation,
      sender: { id: userId },
      chat: TASK_TOPIC_CHAT,
      telegramChatId: '-100123',
      topicId: 17,
      idempotencyKey: 'own-topic',
    });
    expect(created.task.title).toBe(formulation);
    expect(created.task).not.toHaveProperty('githubLink');
    expect(created.task).not.toHaveProperty('issue');
    expect(placed.tasks).toEqual([created.task]);
    const payload = journal.rows[0]?.payload;
    expect(payload).toEqual({
      task_id: openTask.id,
      project_id: projectId,
      number: 1,
      title: formulation,
      assignee_id: userId,
      priority: 'normal',
    });
    expect(Object.keys(TaskCreatedPayloadSchema.shape).sort()).toEqual([
      'assignee_id',
      'number',
      'priority',
      'project_id',
      'task_id',
      'title',
    ]);
    expect(journal.rows[0]?.eventType).toBe(EVENT_TYPES.TASK_CREATED);
  });

  it('INV-04 чужой топик задачу ему не создаёт, шага «выберите issue» нет', async () => {
    const owner: TopicOwner = { projectId, userId, name: 'Альфа', role: TASK_ASSIGNEE_MEMBER };
    const placed = fakeStore([owner]);
    const journal = memoryJournal();
    await expect(
      createTask(placed.store, journal.journal, clock, {
        id: openTask.id,
        title: formulation,
        sender: { id: '00000000-0000-4000-8000-000000000002' },
        chat: TASK_TOPIC_CHAT,
        telegramChatId: '-100123',
        topicId: 17,
        idempotencyKey: 'foreign-topic',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_PLACE });
    expect(placed.tasks).toEqual([]);
    expect(journal.rows).toEqual([]);

    expect(() => acceptedTaskText(formulation, { issueNumber: 12 })).toThrow(DomainError);
    expect(() => acceptedTaskText(formulation, { issueNumber: 12 })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_ISSUE_STEP }),
    );
    expect(acceptedTaskText(formulation).issueStep).toBeNull();

    const prompts = tsFiles('src/telegram').filter((file) => readFileSync(file, 'utf8').toLowerCase().includes('выберите issue'));
    expect(prompts).toEqual([]);
  });

  it('INV-04 работа без задачи в блок «Задачи» не попадает; milestone не этап задачи', () => {
    const kept = taskApartFromMilestone(openTask, { title: TASK_STATUS_DONE });
    expect(kept).toEqual(openTask);
    expect(kept.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(taskApartFromMilestone(openTask, { title: formulation }).title).toBe(formulation);
    expect(milestoneAsTaskStatus('Pilot')).toBeNull();
    expect(milestoneAsTaskStatus(TASK_STATUS_DONE)).toBeNull();
    expect(TASK_STATUSES).not.toContain('milestone');
    expect(() => taskStatus('milestone')).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_STATUS }));
    expect(() => taskStatus('Pilot')).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_STATUS }));

    const block = tasksBlock([
      { source: 'github', fact: 'issue' },
      { source: 'github', fact: 'pull_request' },
      { source: 'github', fact: 'commit' },
      { source: 'github', fact: 'milestone' },
      { source: 'github', fact: 'assignment' },
      { source: 'task', task: openTask },
    ]);
    expect(block).toEqual([openTask]);
    expect(tasksBlock([{ source: 'github', fact: 'issue' }])).toEqual([]);
  });

  it('INV-04 у задачи нет веса, процента и внешнего ключа на зеркало', async () => {
    expect(defineUnlinked(openTask)).toEqual(openTask);
    const withWeight = { ...openTask, weight: 1 } as Task;
    const withPercent = { ...openTask, percent: 1 } as Task;
    const withKey = { ...openTask, issue_id: projectId } as Task;
    expect(() => defineUnlinked(withWeight)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_MEASURE }));
    expect(() => defineUnlinked(withPercent)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_MEASURE }));
    expect(() => defineUnlinked(withKey)).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.TASK_EXTERNAL_KEY }));

    const db = await openTasks();
    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
    `.execute(db);
    const names = columns.rows.map((row) => row.column_name);
    for (const field of [...ABSENT_TASK_MEASURES, ...ABSENT_EXTERNAL_KEYS]) {
      expect(names).not.toContain(field);
    }
    const links = await sql<{ column_name: string; foreign_table: string }>`
      SELECT att.attname AS column_name, ref.relname AS foreign_table
      FROM pg_constraint AS con
      JOIN pg_class AS rel ON rel.oid = con.conrelid
      JOIN pg_class AS ref ON ref.oid = con.confrelid
      JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND rel.relname = 'tasks'
    `.execute(db);
    expect(links.rows.map((row) => `${row.column_name}->${row.foreign_table}`).sort()).toEqual([
      'assignee_id->users',
      'project_id->projects',
    ]);

    await sql`
      INSERT INTO users (id, telegram_user_id, name, is_root)
      VALUES (${userId}::uuid, 1001, 'Аня', true)
    `.execute(db);
    await sql`
      INSERT INTO projects (id, name, description, timezone, chat_id, created_at)
      VALUES (${projectId}::uuid, 'Альфа', '', 'Europe/Moscow', NULL, ${at}::timestamptz)
    `.execute(db);
    const milestoneStatus = sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES (
        ${openTask.id}::uuid,
        ${projectId}::uuid,
        1,
        'Pilot',
        'milestone',
        'normal',
        ${userId}::uuid,
        ${at}::timestamptz,
        ${at}::timestamptz
      )
    `.execute(db);
    await expect(milestoneStatus).rejects.toThrow(/tasks_status|23514/);
    await db.destroy();
  });
});
