import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import { TASK_ACTOR_ROLE, TASK_SUBJECT, TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import {
  awaitsLeadConfirmation,
  reasonBeingClarified,
  standsInTasksBlock,
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  TASK_STATUSES,
  type TaskStatus,
} from '../src/domain/tasks/status.ts';
import { markActFor, TASK_TRANSITION_CHECK, TASK_TRANSITION_UNCHECK, transitionTask } from '../src/domain/tasks/transition.ts';
import { emit, EVENT_TYPES } from '../src/events/index.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import { createCanvasPlacement, type CanvasHome } from '../src/infrastructure/canvas.ts';
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
import { createTaskActions, createTaskMarkActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { CANVAS_DESTINATION_TOPIC } from '../src/domain/tasks/place-canvas.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import { parseTaskMarkData, replyToTaskMark } from '../src/telegram/task-mark.ts';
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

const GITHUB_ACTS = [
  EVENT_TYPES.GITHUB_ISSUE_CHANGED,
  EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
  EVENT_TYPES.GITHUB_COMMITS_PUSHED,
  EVENT_TYPES.TASK_CONFIRMED,
  EVENT_TYPES.TASK_RETURNED,
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
  completedAt: Date | null;
  number: number;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function place(topicId: number | undefined, type = TASK_TOPIC_CHAT, id = telegramChatId) {
  return { type, id, topicId };
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
    completed_at: Date | null;
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
    completedAt: row.completed_at,
    number: Number(row.number),
  }));
}

async function markEvents(db: Kysely<Database>): Promise<{ type: string; key: string; payload: unknown; actorId: string; actorRole: string; subject: string }[]> {
  const result = await sql<{
    event_type: string;
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
  }>`
    SELECT event_type, idempotency_key, payload, actor_id, actor_role, subject_entity
    FROM events
    WHERE event_type IN (${EVENT_TYPES.TASK_CHECKED}, ${EVENT_TYPES.TASK_UNCHECKED})
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    type: row.event_type,
    key: row.idempotency_key,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subject: row.subject_entity,
  }));
}

async function setStatus(db: Kysely<Database>, id: string, status: TaskStatus): Promise<void> {
  await sql`UPDATE tasks SET status = ${status} WHERE id = ${id}::uuid`.execute(db);
}

describe('переход галочки', () => {
  it('INV-05 у задачи один статус, переход только по таблице; GitHub и чужой акт статус не меняют', () => {
    const allowed = new Map<string, TaskStatus>([
      [`${TASK_TRANSITION_CHECK}:${TASK_STATUS_IN_PROGRESS}`, TASK_STATUS_REVIEW],
      [`${TASK_TRANSITION_CHECK}:${TASK_STATUS_BLOCKED}`, TASK_STATUS_REVIEW],
      [`${TASK_TRANSITION_UNCHECK}:${TASK_STATUS_REVIEW}`, TASK_STATUS_IN_PROGRESS],
    ]);
    const acts = [TASK_TRANSITION_CHECK, TASK_TRANSITION_UNCHECK, ...GITHUB_ACTS];
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUSES.filter((item) => item === status)).toHaveLength(1);
      for (const act of acts) {
        const key = `${act}:${status}`;
        const next = allowed.get(key);
        if (next === undefined) {
          expect(() => transitionTask(status, act)).toThrowError(expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }));
          continue;
        }
        const move = transitionTask(status, act);
        expect(move.from).toBe(status);
        expect(move.to).toBe(next);
        expect(move.to).not.toBe(TASK_STATUS_DONE);
        expect([move.to]).toHaveLength(1);
      }
    }
    expect(markActFor(TASK_STATUS_REVIEW)).toBe(TASK_TRANSITION_UNCHECK);
    expect(markActFor(TASK_STATUS_IN_PROGRESS)).toBe(TASK_TRANSITION_CHECK);
    expect(markActFor(TASK_STATUS_BLOCKED)).toBe(TASK_TRANSITION_CHECK);
    const writers = tsFiles('src').filter((file) => readFileSync(file, 'utf8').includes("updateTable('tasks')"));
    expect(writers).toEqual(['src/infrastructure/tasks.ts']);
  });

  it('INV-11 галочка не задаёт причину; выход из BLOCKED закрывает блокер; DONE этой кнопкой не ставится', () => {
    expect(reasonBeingClarified(TASK_STATUS_BLOCKED)).toBe(true);
    expect(TASK_STATUSES.filter((status) => reasonBeingClarified(status))).toEqual([TASK_STATUS_BLOCKED]);
    expect(awaitsLeadConfirmation(TASK_STATUS_REVIEW)).toBe(true);
    expect(TASK_STATUSES.filter((status) => awaitsLeadConfirmation(status))).toEqual([TASK_STATUS_REVIEW]);

    const blocked = transitionTask(TASK_STATUS_BLOCKED, TASK_TRANSITION_CHECK);
    expect(blocked.to).toBe(TASK_STATUS_REVIEW);
    expect(blocked.closesBlocker).toBe(true);
    expect(reasonBeingClarified(blocked.to)).toBe(false);
    expect(awaitsLeadConfirmation(blocked.to)).toBe(true);
    expect(Object.keys(blocked).sort()).toEqual(['closesBlocker', 'from', 'to']);

    const progress = transitionTask(TASK_STATUS_IN_PROGRESS, TASK_TRANSITION_CHECK);
    expect(progress.closesBlocker).toBe(false);
    expect(progress.to).toBe(TASK_STATUS_REVIEW);

    const back = transitionTask(TASK_STATUS_REVIEW, TASK_TRANSITION_UNCHECK);
    expect(back.to).toBe(TASK_STATUS_IN_PROGRESS);
    expect(back.closesBlocker).toBe(false);
    expect(awaitsLeadConfirmation(back.to)).toBe(false);
    expect(standsInTasksBlock(back.to)).toBe(true);

    for (const status of TASK_STATUSES) {
      for (const act of [TASK_TRANSITION_CHECK, TASK_TRANSITION_UNCHECK]) {
        try {
          expect(transitionTask(status, act).to).not.toBe(TASK_STATUS_DONE);
        } catch (error) {
          expect(error).toMatchObject({ code: DOMAIN_ERROR.TASK_TRANSITION });
        }
      }
    }
  });
});

describe('галочка задачи', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-640 галочка переводит задачу в REVIEW, R-316 снятие возвращает IN_PROGRESS', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Классификация сигнала',
      idempotencyKey: 'task-1',
    });
    const actions = createTaskMarkActions(fixture.db, clock);
    const checked = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-check', created.task.number, actions);
    expect(checked?.applied).toBe(true);
    expect(checked?.closesBlocker).toBe(false);
    expect(checked?.task.status).toBe(TASK_STATUS_REVIEW);
    expect(awaitsLeadConfirmation(checked?.task.status ?? TASK_STATUS_IN_PROGRESS)).toBe(true);
    expect(checked?.task.completedAt).toBeNull();
    const stored = await tasksOf(fixture.db);
    expect(stored.map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);
    const [event] = await markEvents(fixture.db);
    expect(event).toMatchObject({
      type: EVENT_TYPES.TASK_CHECKED,
      key: 'cb-check',
      payload: { task_id: created.task.id },
      actorId: fixture.borisId,
      actorRole: TASK_ACTOR_ROLE,
      subject: TASK_SUBJECT,
    });
    expect(Object.keys(event?.payload as object)).toEqual(['task_id']);

    const cleared = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-clear', created.task.number, actions);
    expect(cleared?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(cleared?.closesBlocker).toBe(false);
    expect(standsInTasksBlock(cleared?.task.status ?? TASK_STATUS_DONE)).toBe(true);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    const events = await markEvents(fixture.db);
    expect(events.map((item) => item.type)).toEqual([EVENT_TYPES.TASK_CHECKED, EVENT_TYPES.TASK_UNCHECKED]);
  });

  it('INV-22 повтор того же callback не пишет второе событие и не снимает галочку', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Повтор',
      idempotencyKey: 'task-2',
    });
    const actions = createTaskMarkActions(fixture.db, clock);
    const first = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-same', 1, actions);
    const second = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-same', 1, actions);
    expect(first?.applied).toBe(true);
    expect(second?.applied).toBe(false);
    expect(second?.task.status).toBe(TASK_STATUS_REVIEW);
    expect(second?.eventId).toBe(first?.eventId);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);
    expect(await markEvents(fixture.db)).toHaveLength(1);
    const blank = await replyToTaskMark(place(borisTopic), borisAccount, '   ', 1, actions);
    expect(blank).toBeNull();
    expect(await markEvents(fixture.db)).toHaveLength(1);
    expect(created.task.id).toBe(first?.task.id);
  });

  it('INV-05 галочку ставит и снимает исполнитель; событие GitHub статус не меняет', async () => {
    const fixture = await seed();
    opened.push(fixture);
    await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Своя',
      idempotencyKey: 'task-boris',
    });
    const veraTask = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(veraAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: veraTopic,
      title: 'Руководителя',
      idempotencyKey: 'task-vera',
    });
    const actions = createTaskMarkActions(fixture.db, clock);
    expect(await replyToTaskMark(place(borisTopic), veraAccount, 'cb-lead', 1, actions)).toBeNull();
    expect(await replyToTaskMark(place(borisTopic), rootAccount, 'cb-root', 1, actions)).toBeNull();
    expect(await replyToTaskMark(place(veraTopic), borisAccount, 'cb-foreign', veraTask.task.number, actions)).toBeNull();
    expect(await replyToTaskMark(place(undefined), borisAccount, 'cb-general', 1, actions)).toBeNull();
    expect(await replyToTaskMark(place(borisTopic, 'private', '1002'), borisAccount, 'cb-private', 1, actions)).toBeNull();
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS, TASK_STATUS_IN_PROGRESS]);
    expect(await markEvents(fixture.db)).toEqual([]);

    const own = await replyToTaskMark(place(veraTopic), veraAccount, 'cb-vera', veraTask.task.number, actions);
    expect(own?.task.status).toBe(TASK_STATUS_REVIEW);
    expect(own?.task.assigneeId).toBe(fixture.veraId);

    await emit(createEventJournal(fixture.db), {
      type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      source: 'github',
      idempotencyKey: 'gh-status',
      payload: {
        repository_id: 'repo-1',
        issue_number: 1,
        title: 'закрыли',
        state: 'closed',
        state_reason: 'completed',
        assignees: ['boris'],
        closed_by_login: 'boris',
        updated_at: at,
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Issue', id: '1' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    const after = await tasksOf(fixture.db);
    expect(after.find((task) => task.number === 1)?.status).toBe(TASK_STATUS_IN_PROGRESS);
    expect(after.find((task) => task.assigneeId === fixture.veraId)?.status).toBe(TASK_STATUS_REVIEW);
  });

  it('INV-11 из BLOCKED галочка закрывает блокер и не ставит DONE; снять можно только с REVIEW', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Ждёт причину',
      idempotencyKey: 'task-blocked',
    });
    await setStatus(fixture.db, created.task.id, TASK_STATUS_BLOCKED);
    const actions = createTaskMarkActions(fixture.db, clock);
    const checked = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-blocked', 1, actions);
    expect(checked?.applied).toBe(true);
    expect(checked?.closesBlocker).toBe(true);
    expect(checked?.task.status).toBe(TASK_STATUS_REVIEW);
    expect(reasonBeingClarified(TASK_STATUS_BLOCKED)).toBe(true);
    expect(reasonBeingClarified(checked?.task.status ?? TASK_STATUS_BLOCKED)).toBe(false);
    expect((await markEvents(fixture.db))[0]?.payload).toEqual({ task_id: created.task.id });
    expect((await tasksOf(fixture.db))[0]?.completedAt).toBeNull();

    await setStatus(fixture.db, created.task.id, TASK_STATUS_PLANNED);
    expect(await replyToTaskMark(place(borisTopic), borisAccount, 'cb-planned', 1, actions)).toBeNull();
    await setStatus(fixture.db, created.task.id, TASK_STATUS_DONE);
    expect(await replyToTaskMark(place(borisTopic), borisAccount, 'cb-done', 1, actions)).toBeNull();
    await setStatus(fixture.db, created.task.id, TASK_STATUS_CANCELLED);
    expect(await replyToTaskMark(place(borisTopic), borisAccount, 'cb-cancelled', 1, actions)).toBeNull();
    expect((await tasksOf(fixture.db))[0]?.status).toBe(TASK_STATUS_CANCELLED);
    expect((await markEvents(fixture.db)).map((event) => event.type)).toEqual([EVENT_TYPES.TASK_CHECKED]);
  });

  it('R-609 отмеченным пункт становится после callback, когда бот перерисовал строку', async () => {
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
    expect(homes[0]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    const before = JSON.stringify(homes[0]?.tasks);
    expect(before).toContain(TASK_STATUS_IN_PROGRESS);
    expect(before).not.toContain(TASK_STATUS_REVIEW);

    const marked = await replyToTaskMark(place(borisTopic), borisAccount, 'cb-redraw', 1, createTaskMarkActions(fixture.db, clock));
    expect(marked).not.toBeNull();
    await canvas.show({
      projectId: fixture.alphaId,
      assigneeId: fixture.borisId,
      destination: CANVAS_DESTINATION_TOPIC,
      causationId: marked?.eventId ?? '',
      send: deliver.send,
      edit: deliver.edit,
    });
    expect(homes).toHaveLength(2);
    expect(homes[1]?.tasks.map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);
    expect(homes[0]?.tasks[0]?.status).toBe(TASK_STATUS_IN_PROGRESS);
  });

  it('parseTaskMarkData читает номер только у кружка', () => {
    expect(parseTaskMarkData('task:mark:7')).toBe(7);
    expect(parseTaskMarkData('task:plan:7')).toBeNull();
    expect(parseTaskMarkData('task:mark:0')).toBeNull();
    expect(parseTaskMarkData('task:mark:01')).toBeNull();
  });
});

describe('бот ставит галочку по callback', () => {
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

  it('R-154 нажатие кружка ставит галочку, R-155 повтор до подтверждения снимает, чужой не меняет', async () => {
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
    const taskStatusCode = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      JSON.stringify({
        update_id: 910,
        message: {
          message_id: 910,
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
    expect(taskStatusCode).toBe(200);
    const posted = calls.find((call) => call.method === 'sendRichMessage');
    expect(JSON.stringify(posted?.payload)).toContain('○');
    expect(JSON.stringify(posted?.payload)).toContain('task:mark:1');
    expect(JSON.stringify(posted?.payload)).not.toContain('на подтверждении');

    const checked = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(911, borisAccount, 'cb-bot-1', 'task:mark:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(checked).toBe(200);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);
    const edited = calls.filter((call) => call.method === 'editMessageText');
    expect(edited).toHaveLength(1);
    expect(JSON.stringify(edited[0]?.payload)).toContain('✓');
    expect(JSON.stringify(edited[0]?.payload)).toContain('на подтверждении');
    expect(JSON.stringify(edited[0]?.payload)).toContain('task:mark:1');
    expect(calls.some((call) => call.method === 'answerCallbackQuery')).toBe(true);

    const foreign = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(912, veraAccount, 'cb-bot-foreign', 'task:mark:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(foreign).toBe(200);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_REVIEW]);
    expect(calls.filter((call) => call.method === 'editMessageText')).toHaveLength(1);

    const cleared = await httpStatus(
      running.port,
      'POST',
      TELEGRAM_WEBHOOK_PATH,
      callback(913, borisAccount, 'cb-bot-2', 'task:mark:1', borisTopic),
      { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
    );
    expect(cleared).toBe(200);
    expect((await tasksOf(fixture.db)).map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    const redrawn = calls.filter((call) => call.method === 'editMessageText');
    expect(redrawn).toHaveLength(2);
    expect(JSON.stringify(redrawn[1]?.payload)).toContain('○');
    expect(JSON.stringify(redrawn[1]?.payload)).not.toContain('на подтверждении');
    const events = await markEvents(fixture.db);
    expect(events.map((event) => event.key)).toEqual(['cb-bot-1', 'cb-bot-2']);
  });
});
