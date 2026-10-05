import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { TASK_PRIORITY_ACT } from '../src/domain/tasks/plan-task.ts';
import { TASK_PRIORITY_HIGH, TASK_PRIORITY_NORMAL, TASK_STATUS_CANCELLED, TASK_STATUS_DONE, TASK_STATUS_IN_PROGRESS, TASK_STATUS_PLANNED, TASK_STATUS_REVIEW } from '../src/domain/tasks/status.ts';
import { TASK_TRANSITION_CONFIRM, TASK_TRANSITION_PLAN, TASK_TRANSITION_RESUME, TASK_TRANSITION_RETURN } from '../src/domain/tasks/transition.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import {
  readBlockersMigration,
  readCanvasesMigration,
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createTaskActions, createTaskCancelActions, createTaskMarkActions, createTaskPlanActions, createTaskReviewActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { replyToTaskCancel } from '../src/telegram/task-cancel.ts';
import { replyToTaskMark } from '../src/telegram/task-mark.ts';
import { replyToTaskPlan } from '../src/telegram/task-plan.ts';
import { replyToTaskReview } from '../src/telegram/task-review.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-10-05T05:00:00.000Z') };
const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const telegramChatId = '-1001234567890';
const borisTopic = 17;
const alphaMessage = 501;
const betaMessage = 502;

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

interface Row {
  projectId: string;
  number: number;
  status: string;
  priority: string;
}

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readBlockersMigration());
  await pglite.exec(readCanvasesMigration());
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite, onCreateConnection: assumeJournalRole }) });
  return {
    db,
    async close() {
      await db.destroy();
    },
  };
}

function place(messageId: number) {
  return { type: TASK_TOPIC_CHAT, id: telegramChatId, topicId: borisTopic, messageId };
}

async function rowsOf(db: Kysely<Database>): Promise<Row[]> {
  const result = await sql<{ project_id: string; number: number | string; status: string; priority: string }>`
    SELECT project_id::text AS project_id, number, status, priority
    FROM tasks
    ORDER BY project_id::text
  `.execute(db);
  return result.rows.map((row) => ({
    projectId: row.project_id,
    number: Number(row.number),
    status: row.status,
    priority: row.priority,
  }));
}

describe('кнопка канваса', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-23 R-1003 R-1004 R-1005 R-1006 R-1007 R-1008 R-1009 R-1010 кнопка меняет задачу нажатого канваса', async () => {
    const handle = await openDb();
    opened.push(handle);
    const registration = createUserRegistration(handle.db, silentLogger, clock);
    await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
    const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
    const creation = createProjectCreation(handle.db, silentLogger, clock);
    const alpha = await creation.create({
      telegramUserId: String(rootAccount.id),
      name: 'Альфа',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-alpha',
    });
    const beta = await creation.create({
      telegramUserId: String(rootAccount.id),
      name: 'Бета',
      description: '',
      timezone: 'Europe/Moscow',
      chat: 'private',
      idempotencyKey: 'project-beta',
    });
    const membership = createMembership(handle.db, silentLogger, clock);
    await membership.add({
      telegramUserId: String(rootAccount.id),
      projectId: alpha.project.id,
      targetTelegramUserId: String(borisAccount.id),
      chat: 'private',
      idempotencyKey: 'add-boris-alpha',
    });
    await membership.add({
      telegramUserId: String(rootAccount.id),
      projectId: beta.project.id,
      targetTelegramUserId: String(borisAccount.id),
      chat: 'private',
      idempotencyKey: 'add-boris-beta',
    });
    await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid`.execute(handle.db);
    const binding = createChatBinding(handle.db, silentLogger, clock);
    await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId: alpha.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-alpha',
    });
    await binding.confirm({
      telegramUserId: String(rootAccount.id),
      projectId: beta.project.id,
      offer: forumAdmin,
      idempotencyKey: 'bind-beta',
    });
    const tasks = createTaskActions(handle.db, silentLogger, clock);
    const draft = {
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
    };
    await tasks.pick({ ...draft, projectId: alpha.project.id, title: 'Альфа', idempotencyKey: 'task-alpha' });
    await tasks.pick({ ...draft, projectId: beta.project.id, title: 'Бета', idempotencyKey: 'task-beta' });
    await sql`
      INSERT INTO canvases (id, project_id, assignee_id, topic_id, message_id, canvas_date)
      VALUES
        (${'00000000-0000-4000-8000-0000000000a1'}::uuid, ${alpha.project.id}::uuid, ${boris.user.id}::uuid, ${borisTopic}, ${alphaMessage}, ${'2026-10-05'}::date),
        (${'00000000-0000-4000-8000-0000000000b1'}::uuid, ${beta.project.id}::uuid, ${boris.user.id}::uuid, ${borisTopic}, ${betaMessage}, ${'2026-10-05'}::date)
    `.execute(handle.db);

    const mark = createTaskMarkActions(handle.db, silentLogger, clock);
    const plan = createTaskPlanActions(handle.db, silentLogger, clock);
    const review = createTaskReviewActions(handle.db, silentLogger, clock);
    const cancel = createTaskCancelActions(handle.db, silentLogger, clock);
    const alphaPlace = place(alphaMessage);
    const betaPlace = place(betaMessage);

    expect((await replyToTaskMark(alphaPlace, borisAccount, 'cb-mark', 1, mark))?.task.projectId).toBe(alpha.project.id);
    const marked = await rowsOf(handle.db);
    expect(marked.find((row) => row.projectId === alpha.project.id)).toEqual({
      projectId: alpha.project.id,
      number: 1,
      status: TASK_STATUS_REVIEW,
      priority: TASK_PRIORITY_NORMAL,
    });
    expect(marked.find((row) => row.projectId === beta.project.id)).toEqual({
      projectId: beta.project.id,
      number: 1,
      status: TASK_STATUS_IN_PROGRESS,
      priority: TASK_PRIORITY_NORMAL,
    });
    await replyToTaskMark(alphaPlace, borisAccount, 'cb-unmark', 1, mark);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === alpha.project.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === beta.project.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);

    expect((await replyToTaskPlan(alphaPlace, borisAccount, 'cb-word', 1, TASK_PRIORITY_ACT, plan))?.task.priority).toBe(TASK_PRIORITY_HIGH);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === beta.project.id)?.priority).toBe(TASK_PRIORITY_NORMAL);

    expect((await replyToTaskPlan(alphaPlace, borisAccount, 'cb-plan', 1, TASK_TRANSITION_PLAN, plan))?.task.status).toBe(TASK_STATUS_PLANNED);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === beta.project.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect((await replyToTaskPlan(alphaPlace, borisAccount, 'cb-resume', 1, TASK_TRANSITION_RESUME, plan))?.task.status).toBe(TASK_STATUS_IN_PROGRESS);

    await replyToTaskMark(alphaPlace, borisAccount, 'cb-mark-2', 1, mark);
    expect((await replyToTaskReview(alphaPlace, rootAccount, 'cb-confirm', 1, TASK_TRANSITION_CONFIRM, review))?.task.status).toBe(TASK_STATUS_DONE);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === beta.project.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);

    await replyToTaskMark(betaPlace, borisAccount, 'cb-mark-beta', 1, mark);
    expect((await replyToTaskReview(betaPlace, rootAccount, 'cb-return', 1, TASK_TRANSITION_RETURN, review))?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect((await rowsOf(handle.db)).find((row) => row.projectId === alpha.project.id)?.status).toBe(TASK_STATUS_DONE);

    expect((await replyToTaskCancel(betaPlace, borisAccount, 'cb-cancel', 1, cancel))?.task.status).toBe(TASK_STATUS_CANCELLED);
    const cancelled = await rowsOf(handle.db);
    expect(cancelled.find((row) => row.projectId === alpha.project.id)).toEqual({
      projectId: alpha.project.id,
      number: 1,
      status: TASK_STATUS_DONE,
      priority: TASK_PRIORITY_HIGH,
    });
    expect(cancelled.find((row) => row.projectId === beta.project.id)).toEqual({
      projectId: beta.project.id,
      number: 1,
      status: TASK_STATUS_CANCELLED,
      priority: TASK_PRIORITY_NORMAL,
    });
  });
});
