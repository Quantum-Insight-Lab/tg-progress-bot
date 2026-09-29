import type { Transformer } from 'grammy';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE, MEMBER_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_ACTOR_ROLE, TASK_ASSIGNEE_LEAD, TASK_SUBJECT, TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { GITHUB_FACT_TYPES, type GithubFact } from '../src/domain/tasks/github-origin.ts';
import { defineUnlinked } from '../src/domain/tasks/github-link.ts';
import {
  confirmationFromGithub,
  pressTaskReview,
  TASK_LEAD_ACTOR_ROLE,
  type TaskReviewPress,
  type TaskReviewStore,
} from '../src/domain/tasks/review-task.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
  standsInTasksBlock,
  type TaskStatus,
} from '../src/domain/tasks/status.ts';
import type { Task } from '../src/domain/tasks/task.ts';
import {
  openForDismissal,
  TASK_TRANSITION_CHECK,
  TASK_TRANSITION_CONFIRM,
  TASK_TRANSITION_RETURN,
  TASK_TRANSITION_UNCHECK,
  transitionTask,
  type ReviewDecision,
} from '../src/domain/tasks/transition.ts';
import { emit, EVENT_TYPES, type EventJournal, type EventRow } from '../src/events/index.ts';
import { createCanvasPlacement, type CanvasHome } from '../src/infrastructure/canvas.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
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
import { createTaskActions, createTaskMarkActions, createTaskReviewActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { CANVAS_DESTINATION_TOPIC } from '../src/domain/tasks/place-canvas.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { parseTaskReviewData, replyToTaskReview } from '../src/telegram/task-review.ts';
import { replyToTaskMark } from '../src/telegram/task-mark.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const at = '2026-09-28T07:33:00.000Z';

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const borisTopic = 17;
const veraTopic = 18;

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

const NEUTRAL_ACTS = [
  TASK_TRANSITION_CHECK,
  TASK_TRANSITION_UNCHECK,
  TASK_TRANSITION_CONFIRM,
  TASK_TRANSITION_RETURN,
  ...GITHUB_FACT_TYPES,
  EVENT_TYPES.DIVERGENCE_DETECTED,
] as const;

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  alphaId: string;
  borisId: string;
  veraId: string;
  rootId: string;
}

interface StoredTask {
  id: string;
  status: string;
  assigneeId: string;
  completedAt: string | null;
  number: number;
}

function place(topicId: number | undefined, type = TASK_TOPIC_CHAT, id = telegramChatId) {
  return { type, id, topicId };
}

function lead(over: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    role: TASK_ASSIGNEE_LEAD,
    actorId: 'lead-1',
    assigneeId: 'worker-1',
    leadCount: 1,
    openBlocker: false,
    ...over,
  };
}

function reviewTask(status: TaskStatus, assigneeId: string): Task {
  return defineUnlinked({
    id: '00000000-0000-4000-8000-0000000000aa',
    projectId: '00000000-0000-4000-8000-0000000000bb',
    number: 1,
    title: 'Сигнал',
    status,
    priority: 'normal',
    assigneeId,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  });
}

function memoryJournal(): { journal: EventJournal; rows: EventRow[] } {
  const rows: EventRow[] = [];
  return {
    rows,
    journal: {
      async append(row) {
        const found = rows.find((item) => item.idempotencyKey === row.idempotencyKey);
        if (found !== undefined) return { inserted: false, row: found };
        rows.push(row);
        return { inserted: true, row };
      },
    },
  };
}

function memoryStore(
  task: Task,
  rows: EventRow[],
  options: { senderId: string | null; role: string | null; leadCount: number; openBlocker: boolean },
): { store: TaskReviewStore; current: () => Task } {
  let current = task;
  return {
    current: () => current,
    store: {
      async sender() {
        return options.senderId === null ? null : { id: options.senderId };
      },
      async tasksInTopic() {
        return [current];
      },
      async membership() {
        return options.role === null ? null : { role: options.role };
      },
      async leadCount() {
        return options.leadCount;
      },
      async openBlocker() {
        return options.openBlocker;
      },
      async seen(idempotencyKey) {
        const row = rows.find((item) => item.idempotencyKey === idempotencyKey);
        if (row === undefined) return null;
        return { eventId: row.id };
      },
      async saveStatus(next, from) {
        if (current.status !== from) return false;
        current = next;
        return true;
      },
    },
  };
}

function pressOf(task: Task, options: { senderId: string | null; role: string | null; leadCount: number; openBlocker: boolean }) {
  const stored = memoryJournal();
  const backing = memoryStore(task, stored.rows, options);
  return {
    rows: stored.rows,
    current: backing.current,
    press(input: Partial<TaskReviewPress> = {}) {
      return pressTaskReview(backing.store, stored.journal, clock, {
        telegramUserId: '1003',
        chat: TASK_TOPIC_CHAT,
        telegramChatId,
        topicId: veraTopic,
        taskNumber: 1,
        act: TASK_TRANSITION_CONFIRM,
        idempotencyKey: 'cb-memory',
        ...input,
      });
    },
  };
}

const closedIssue = {
  type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
  payload: {
    repository_id: 'repo-1',
    issue_number: 4,
    title: 'закрыли',
    state: 'closed',
    state_reason: 'completed',
    assignees: ['boris'],
    closed_by_login: 'boris',
    updated_at: at,
  },
} satisfies GithubFact;

const mergedPull = {
  type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
  payload: {
    repository_id: 'repo-1',
    pull_request_number: 7,
    title: 'смержили',
    state: 'merged',
    author_login: 'boris',
    updated_at: at,
    merged_at: at,
    merged_by_login: 'boris',
  },
} satisfies GithubFact;

const greenCi = {
  type: EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED,
  payload: {
    repository_id: 'repo-1',
    branch: 'main',
    is_default_branch: true,
    conclusion: 'success',
    pull_request_numbers: [7],
  },
} satisfies GithubFact;

const githubFacts: GithubFact[] = [closedIssue, mergedPull, greenCi];

describe('переход подтверждения', () => {
  it('INV-05 у задачи один статус, переход только по таблице; из DONE хода нет; GitHub и расхождение статус не меняют', () => {
    const mark = new Map<string, TaskStatus>([
      [`${TASK_TRANSITION_CHECK}:${TASK_STATUS_IN_PROGRESS}`, TASK_STATUS_REVIEW],
      [`${TASK_TRANSITION_CHECK}:${TASK_STATUS_BLOCKED}`, TASK_STATUS_REVIEW],
      [`${TASK_TRANSITION_UNCHECK}:${TASK_STATUS_REVIEW}`, TASK_STATUS_IN_PROGRESS],
    ]);
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES.filter((item) => item === status)).toHaveLength(1);
      expect(openForDismissal(status)).toBe(status !== TASK_STATUS_DONE);
      for (const act of NEUTRAL_ACTS) {
        if (status === TASK_STATUS_DONE) {
          expect(() => transitionTask(status, act, lead({ actorId: 'same', assigneeId: 'same' }))).toThrowError(
            expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
          );
          continue;
        }
        if (status === TASK_STATUS_REVIEW && act === TASK_TRANSITION_CONFIRM) {
          expect(() => transitionTask(status, act)).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_CONFIRM_ACTOR }));
          const move = transitionTask(status, act, lead());
          expect(move.to).toBe(TASK_STATUS_DONE);
          expect(move.closesBlocker).toBe(false);
          expect(openForDismissal(move.to)).toBe(false);
          continue;
        }
        if (status === TASK_STATUS_REVIEW && act === TASK_TRANSITION_RETURN) {
          expect(() => transitionTask(status, act)).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_CONFIRM_ACTOR }));
          const move = transitionTask(status, act, lead());
          expect(move.to).toBe(TASK_STATUS_IN_PROGRESS);
          expect(standsInTasksBlock(move.to)).toBe(true);
          continue;
        }
        const next = mark.get(`${act}:${status}`);
        if (next === undefined) {
          expect(() => transitionTask(status, act, lead())).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }));
          continue;
        }
        const move = transitionTask(status, act);
        expect(move.to).toBe(next);
        expect(move.to).not.toBe(TASK_STATUS_DONE);
      }
    }
    expect(confirmationFromGithub(githubFacts)).toBeNull();
  });

  it('INV-11 DONE только без открытого блокера; подтверждение не выходит из BLOCKED и блокер не оставляет открытым', async () => {
    expect(() => transitionTask(TASK_STATUS_REVIEW, TASK_TRANSITION_CONFIRM, lead({ openBlocker: true }))).toThrowError(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_OPEN_BLOCKER }),
    );
    expect(() => transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_CONFIRM, lead())).toThrowError(
      expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
    );
    const blocked = transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_CHECK);
    expect(blocked.to).toBe(TASK_STATUS_REVIEW);
    expect(blocked.closesBlocker).toBe(true);
    expect(blocked.to).not.toBe(TASK_STATUS_DONE);

    const held = pressOf(reviewTask(TASK_STATUS_REVIEW, 'worker-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 1,
      openBlocker: true,
    });
    await expect(held.press()).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_OPEN_BLOCKER });
    expect(held.current().status).toBe(TASK_STATUS_REVIEW);
    expect(held.current().completedAt).toBeNull();
    expect(held.rows).toEqual([]);

    const clear = pressOf(reviewTask(TASK_STATUS_REVIEW, 'worker-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 1,
      openBlocker: false,
    });
    const done = await clear.press();
    expect(done.applied).toBe(true);
    expect(done.closesBlocker).toBe(false);
    expect(done.task.status).toBe(TASK_STATUS_DONE);
    expect(done.task.completedAt).toBe(at);
    expect(clear.rows).toHaveLength(1);
  });
});

describe('подтвердить и вернуть', () => {
  it('INV-06 свою задачу подтверждает единственный руководитель, при нескольких — другой; участник не подтверждает', async () => {
    const sole = pressOf(reviewTask(TASK_STATUS_REVIEW, 'lead-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 1,
      openBlocker: false,
    });
    const own = await sole.press();
    expect(own.task.status).toBe(TASK_STATUS_DONE);
    expect(own.task.completedAt).toBe(at);
    expect(sole.rows[0]).toMatchObject({
      eventType: EVENT_TYPES.TASK_CONFIRMED,
      actorId: 'lead-1',
      actorRole: TASK_LEAD_ACTOR_ROLE,
      subjectEntity: TASK_SUBJECT,
      payload: { task_id: own.task.id, confirmed_by: 'lead-1' },
    });

    const crowded = pressOf(reviewTask(TASK_STATUS_REVIEW, 'lead-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 2,
      openBlocker: false,
    });
    await expect(crowded.press()).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_CONFIRM_ACTOR });
    expect(crowded.current().status).toBe(TASK_STATUS_REVIEW);
    expect(crowded.rows).toEqual([]);

    const other = pressOf(reviewTask(TASK_STATUS_REVIEW, 'lead-1'), {
      senderId: 'lead-2',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 2,
      openBlocker: false,
    });
    const byOther = await other.press();
    expect(byOther.task.status).toBe(TASK_STATUS_DONE);
    expect(byOther.task.completedAt).toBe(at);

    const member = pressOf(reviewTask(TASK_STATUS_REVIEW, 'worker-1'), {
      senderId: 'worker-1',
      role: MEMBER_ROLE,
      leadCount: 1,
      openBlocker: false,
    });
    await expect(member.press()).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_CONFIRM_ACTOR });
    await expect(member.press({ act: TASK_TRANSITION_RETURN, idempotencyKey: 'cb-return-member' })).rejects.toMatchObject({
      code: DOMAIN_ERROR.TASK_CONFIRM_ACTOR,
    });
    expect(member.current().status).toBe(TASK_STATUS_REVIEW);
    expect(member.rows).toEqual([]);

    const back = pressOf(reviewTask(TASK_STATUS_REVIEW, 'lead-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 2,
      openBlocker: false,
    });
    const returned = await back.press({ act: TASK_TRANSITION_RETURN, idempotencyKey: 'cb-return' });
    expect(returned.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(returned.task.completedAt).toBeNull();
    expect(returned.closesBlocker).toBe(false);
    expect(back.rows[0]).toMatchObject({
      eventType: EVENT_TYPES.TASK_RETURNED,
      payload: { task_id: returned.task.id, returned_by: 'lead-1' },
    });

    expect(confirmationFromGithub(githubFacts)).toBeNull();
    for (const fact of githubFacts) {
      expect(() => transitionTask(TASK_STATUS_REVIEW, fact.type, lead())).toThrowError(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
      );
    }
  });

  it('INV-22 повтор того же callback не пишет второе событие и не меняет DONE', async () => {
    const run = pressOf(reviewTask(TASK_STATUS_REVIEW, 'worker-1'), {
      senderId: 'lead-1',
      role: TASK_ASSIGNEE_LEAD,
      leadCount: 1,
      openBlocker: false,
    });
    const first = await run.press();
    const second = await run.press();
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.task.status).toBe(TASK_STATUS_DONE);
    expect(second.eventId).toBe(first.eventId);
    expect(run.rows).toHaveLength(1);
    await expect(run.press({ idempotencyKey: '   ' })).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY });
    expect(run.rows).toHaveLength(1);
  });
});

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

async function seed(): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, clock);
  const root = await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
  const creation = createProjectCreation(handle.db, clock);
  const alpha = await creation.create({
    telegramUserId: String(rootAccount.id),
    name: 'Альфа',
    description: '',
    timezone: 'Europe/Moscow',
    chat: 'private',
    idempotencyKey: 'project-alpha',
  });
  const membership = createMembership(handle.db, clock);
  await membership.add({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    targetTelegramUserId: String(borisAccount.id),
    chat: 'private',
    idempotencyKey: 'add-boris',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES (${'00000000-0000-4000-8000-0000000000c1'}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE}, ${veraTopic})
  `.execute(handle.db);
  await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid`.execute(handle.db);
  await createChatBinding(handle.db, clock).confirm({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    offer: forumAdmin,
    idempotencyKey: 'bind-alpha',
  });
  return {
    db: handle.db,
    close: handle.close,
    alphaId: alpha.project.id,
    borisId: boris.user.id,
    veraId: vera.user.id,
    rootId: root.user.id,
  };
}

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const result = await sql<{
    id: string;
    status: string;
    assignee_id: string;
    completed_at: Date | string | null;
    number: number | string;
  }>`
    SELECT id::text AS id, status, assignee_id::text AS assignee_id, completed_at, number
    FROM tasks
    ORDER BY number
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    assigneeId: row.assignee_id,
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    number: Number(row.number),
  }));
}

async function reviewEvents(db: Kysely<Database>): Promise<{ type: string; key: string; payload: unknown; actorId: string; actorRole: string }[]> {
  const result = await sql<{
    event_type: string;
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
  }>`
    SELECT event_type, idempotency_key, payload, actor_id, actor_role
    FROM events
    WHERE event_type IN (${EVENT_TYPES.TASK_CONFIRMED}, ${EVENT_TYPES.TASK_RETURNED})
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    type: row.event_type,
    key: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
    actorId: row.actor_id,
    actorRole: row.actor_role,
  }));
}

async function markReview(fixture: Fixture, account: { id: number; is_bot: boolean; first_name: string }, topicId: number, number: number, key: string): Promise<void> {
  const marked = await replyToTaskMark(place(topicId), account, key, number, createTaskMarkActions(fixture.db, clock));
  expect(marked?.task.status).toBe(TASK_STATUS_REVIEW);
}

describe('кнопки руководителя в проекте', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-06 в базе единственный руководитель подтверждает свою, второй руководитель — чужую; PR, issue и CI не подтверждают', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const veraTask = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(veraAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: veraTopic,
      title: 'Своя',
      idempotencyKey: 'task-vera',
    });
    const borisTask = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Чужая',
      idempotencyKey: 'task-boris',
    });
    await markReview(fixture, veraAccount, veraTopic, veraTask.task.number, 'cb-vera-mark');
    await markReview(fixture, borisAccount, borisTopic, borisTask.task.number, 'cb-boris-mark');
    const actions = createTaskReviewActions(fixture.db, clock);

    expect(await replyToTaskReview(place(veraTopic), borisAccount, 'cb-member', veraTask.task.number, TASK_TRANSITION_CONFIRM, actions)).toBeNull();
    expect(await replyToTaskReview(place(veraTopic), rootAccount, 'cb-root', veraTask.task.number, TASK_TRANSITION_CONFIRM, actions)).toBeNull();
    expect(await replyToTaskReview(place(undefined), veraAccount, 'cb-general', veraTask.task.number, TASK_TRANSITION_CONFIRM, actions)).toBeNull();

    const own = await replyToTaskReview(place(veraTopic), veraAccount, 'cb-own', veraTask.task.number, TASK_TRANSITION_CONFIRM, actions);
    expect(own?.applied).toBe(true);
    expect(own?.task.status).toBe(TASK_STATUS_DONE);
    expect(own?.task.completedAt).toBe(at);
    expect(own?.closesBlocker).toBe(false);
    expect(standsInTasksBlock(TASK_STATUS_DONE)).toBe(false);

    await sql`
      INSERT INTO project_members (id, project_id, user_id, role)
      VALUES (${'00000000-0000-4000-8000-0000000000d1'}::uuid, ${fixture.alphaId}::uuid, ${fixture.rootId}::uuid, ${LEAD_ROLE})
    `.execute(fixture.db);
    expect(
      await replyToTaskReview(place(borisTopic), borisAccount, 'cb-self-member', borisTask.task.number, TASK_TRANSITION_CONFIRM, actions),
    ).toBeNull();
    const byLead = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-other', borisTask.task.number, TASK_TRANSITION_CONFIRM, actions);
    expect(byLead?.task.status).toBe(TASK_STATUS_DONE);
    expect(byLead?.task.assigneeId).toBe(fixture.borisId);

    const again = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(veraAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: veraTopic,
      title: 'Вторая',
      idempotencyKey: 'task-vera-2',
    });
    await markReview(fixture, veraAccount, veraTopic, again.task.number, 'cb-vera-mark-2');
    expect(await replyToTaskReview(place(veraTopic), veraAccount, 'cb-self-two', again.task.number, TASK_TRANSITION_CONFIRM, actions)).toBeNull();
    const byRoot = await replyToTaskReview(place(veraTopic), rootAccount, 'cb-root-other', again.task.number, TASK_TRANSITION_CONFIRM, actions);
    expect(byRoot?.task.status).toBe(TASK_STATUS_DONE);
    expect(byRoot?.task.assigneeId).toBe(fixture.veraId);

    const stored = await tasksOf(fixture.db);
    expect(stored.every((task) => task.status === TASK_STATUS_DONE)).toBe(true);
    expect(stored.every((task) => task.completedAt === at)).toBe(true);

    await emit(createEventJournal(fixture.db), {
      type: closedIssue.type,
      source: 'github',
      idempotencyKey: 'gh-issue',
      payload: closedIssue.payload,
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Issue', id: '4' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db), {
      type: mergedPull.type,
      source: 'github',
      idempotencyKey: 'gh-pr',
      payload: mergedPull.payload,
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'PullRequest', id: '7' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db), {
      type: greenCi.type,
      source: 'github',
      idempotencyKey: 'gh-ci',
      payload: greenCi.payload,
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Workflow', id: 'main' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db), {
      type: EVENT_TYPES.DIVERGENCE_DETECTED,
      source: 'system',
      idempotencyKey: 'div-1',
      payload: { project_id: fixture.alphaId, date: '2026-09-28' },
      actor: { id: 'system', role: 'system' },
      subject: { entity: 'Project', id: fixture.alphaId },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    expect((await tasksOf(fixture.db)).every((task) => task.status === TASK_STATUS_DONE)).toBe(true);
    const events = await reviewEvents(fixture.db);
    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.TASK_CONFIRMED,
      EVENT_TYPES.TASK_CONFIRMED,
      EVENT_TYPES.TASK_CONFIRMED,
    ]);
    expect(events.every((event) => event.actorRole === TASK_LEAD_ACTOR_ROLE)).toBe(true);
    expect(events.every((event) => event.actorRole !== TASK_ACTOR_ROLE)).toBe(true);
  });

  it('INV-22 повтор callback в базе не снимает подтверждение', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Повтор',
      idempotencyKey: 'task-repeat',
    });
    await markReview(fixture, borisAccount, borisTopic, created.task.number, 'cb-mark');
    const actions = createTaskReviewActions(fixture.db, clock);
    const first = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-same', 1, TASK_TRANSITION_CONFIRM, actions);
    const second = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-same', 1, TASK_TRANSITION_CONFIRM, actions);
    expect(first?.applied).toBe(true);
    expect(second?.applied).toBe(false);
    expect(second?.task.status).toBe(TASK_STATUS_DONE);
    expect(second?.eventId).toBe(first?.eventId);
    expect(await reviewEvents(fixture.db)).toHaveLength(1);
    const returned = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-back', 1, TASK_TRANSITION_RETURN, actions);
    expect(returned).toBeNull();
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_DONE);
    expect((await tasksOf(fixture.db))[0]?.completedAt).toBe(at);
  });

  it('INV-11 из BLOCKED и PLANNED подтверждение не ставит DONE', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Ждёт',
      idempotencyKey: 'task-blocked',
    });
    const actions = createTaskReviewActions(fixture.db, clock);
    for (const status of [TASK_STATUS_BLOCKED, TASK_STATUS_PLANNED, TASK_STATUS_IN_PROGRESS, TASK_STATUS_CANCELLED, TASK_STATUS_DONE]) {
      await sql`UPDATE tasks SET status = ${status}, completed_at = NULL WHERE id = ${created.task.id}::uuid`.execute(fixture.db);
      expect(await replyToTaskReview(place(borisTopic), veraAccount, `cb-${status}`, 1, TASK_TRANSITION_CONFIRM, actions)).toBeNull();
      expect(await replyToTaskReview(place(borisTopic), veraAccount, `cb-back-${status}`, 1, TASK_TRANSITION_RETURN, actions)).toBeNull();
      expect((await tasksOf(fixture.db))[0]?.status).toBe(status);
    }
    expect(await reviewEvents(fixture.db)).toEqual([]);
  });

  it('R-319 вернуть возвращает IN_PROGRESS, R-298 подтвердить убирает задачу с канваса', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Классификация сигнала',
      idempotencyKey: 'task-canvas',
    });
    await markReview(fixture, borisAccount, borisTopic, 1, 'cb-mark');
    const homes: CanvasHome[] = [];
    const canvas = createCanvasPlacement(fixture.db, clock);
    const deliver = {
      async send(home: CanvasHome): Promise<number> {
        homes.push(home);
        return 41;
      },
      async edit(home: CanvasHome): Promise<void> {
        homes.push(home);
      },
    };
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: created.eventId,
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(homes[0]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);

    const actions = createTaskReviewActions(fixture.db, clock);
    const returned = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-return', 1, TASK_TRANSITION_RETURN, actions);
    expect(returned?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(returned?.task.completedAt).toBeNull();
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: returned?.eventId ?? '',
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(homes[1]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);

    await markReview(fixture, borisAccount, borisTopic, 1, 'cb-mark-2');
    const confirmed = await replyToTaskReview(place(borisTopic), veraAccount, 'cb-done', 1, TASK_TRANSITION_CONFIRM, actions);
    expect(confirmed?.task.status).toBe(TASK_STATUS_DONE);
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: confirmed?.eventId ?? '',
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(homes[2]?.tasks).toEqual([]);
    expect(parseTaskReviewData('task:confirm:7')).toEqual({ act: TASK_TRANSITION_CONFIRM, taskNumber: 7 });
    expect(parseTaskReviewData('task:return:3')).toEqual({ act: TASK_TRANSITION_RETURN, taskNumber: 3 });
    expect(parseTaskReviewData('task:mark:7')).toBeNull();
    expect(parseTaskReviewData('task:confirm:0')).toBeNull();
  });
});

describe('бот подтверждает и возвращает по callback', () => {
  const calls: { method: string; payload: unknown }[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  function capture(): Transformer {
    return (async (_prev, method, payload) => {
      calls.push({ method, payload });
      if (method === 'sendMessage' || method === 'sendRichMessage' || method === 'editMessageText') {
        return {
          ok: true,
          result: {
            message_id: 77,
            date: 1,
            chat: { id: Number(telegramChatId), type: 'supergroup' },
            rich_message: { blocks: [] },
          },
        };
      }
      return { ok: true, result: true };
    }) as Transformer;
  }

  function callback(updateId: number, account: { id: number; is_bot: boolean; first_name: string }, id: string, data: string, topic: number): string {
    return JSON.stringify({
      update_id: updateId,
      callback_query: {
        id,
        from: account,
        chat_instance: '1',
        data,
        message: {
          message_id: 77,
          date: 1700000000,
          message_thread_id: topic,
          chat: { id: Number(telegramChatId), type: 'supergroup', is_forum: true },
        },
      },
    });
  }

  it('R-298 и R-319 кнопки канваса подтверждают и возвращают, участник статус не меняет', async () => {
    const fixture = await seed();
    opened.push(fixture);
    running = await startProcess({
      ...readProcessConfig(
        {
          TELEGRAM_BOT_TOKEN: 'test-token',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
          PORT: '0',
          SCHEDULER_INTERVAL_MS: '60000',
        },
        clock,
      ),
      host: '127.0.0.1',
      botInfo: testBotInfo,
      db: fixture.db,
    });
    running.bot.api.config.use(capture());
    const created = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      JSON.stringify({
        update_id: 920,
        message: {
          message_id: 920,
          date: 1700000000,
          message_thread_id: borisTopic,
          chat: { id: Number(telegramChatId), type: 'supergroup', is_forum: true },
          from: borisAccount,
          text: '/task Классификация сигнала',
          entities: [{ type: 'bot_command', offset: 0, length: 5 }],
        },
      }),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(created).toBe(200);
    const marked = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(921, borisAccount, 'cb-mark', 'task:mark:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(marked).toBe(200);
    const shown = calls.filter((call) => call.method === 'editMessageText');
    expect(JSON.stringify(shown.at(-1)?.payload)).toContain('task:confirm:1');
    expect(JSON.stringify(shown.at(-1)?.payload)).toContain('task:return:1');

    const member = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(922, borisAccount, 'cb-member', 'task:confirm:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(member).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_REVIEW);

    const returned = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(923, veraAccount, 'cb-return', 'task:return:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(returned).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(JSON.stringify(calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload)).toContain('в план');
    expect(JSON.stringify(calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload)).not.toContain('task:confirm:1');

    await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(924, borisAccount, 'cb-mark-2', 'task:mark:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    const confirmed = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(925, veraAccount, 'cb-confirm', 'task:confirm:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(confirmed).toBe(200);
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_DONE);
    expect((await tasksOf(fixture.db))[0]?.completedAt).toBe(at);
    expect(JSON.stringify(calls.filter((call) => call.method === 'editMessageText').at(-1)?.payload)).not.toContain('Классификация сигнала');
    expect(calls.some((call) => call.method === 'answerCallbackQuery')).toBe(true);
  });
});
