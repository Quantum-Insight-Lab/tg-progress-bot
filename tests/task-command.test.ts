import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Transformer } from 'grammy';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY } from '../src/config/constants.ts';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import { LEAD_ROLE } from '../src/domain/projects/member.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import {
  createTask,
  TASK_ACTOR_ROLE,
  TASK_ASSIGNEE_LEAD,
  TASK_SUBJECT,
  TASK_TOPIC_CHAT,
  taskFormulation,
  type TaskStore,
  type TopicOwner,
} from '../src/domain/tasks/create-task.ts';
import { TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import type { Task } from '../src/domain/tasks/task.ts';
import { emit, EVENT_TYPES, type EventJournal, type EventRow } from '../src/events/index.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import { createEventJournal } from '../src/infrastructure/event-journal.ts';
import { createMembership } from '../src/infrastructure/membership.ts';
import {
  readChatsMigration,
  readEventsMigration,
  readMemberTopicMigration,
  readProjectMembersMigration,
  readProjectsMigration,
  readCanvasesMigration,
  readTasksMigration,
  readUsersMigration,
} from '../src/infrastructure/migrate.ts';
import { createProjectCreation } from '../src/infrastructure/projects.ts';
import { createTaskActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { readProcessConfig, startProcess, type RunningProcess } from '../src/process.ts';
import {
  parseTaskCommand,
  parseTaskProjectData,
  replyToTaskCommand,
  replyToTaskProject,
  TASK_NEEDS_TITLE,
  TASK_OWN_TOPIC,
  TASK_PICK_PROJECT,
  taskCreatedReply,
  taskProjectKeyboard,
} from '../src/telegram/task-command.ts';
import { TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';
import { testBotInfo } from './bot-info.ts';
import { httpStatus } from './http.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-28T07:33:00.000Z') };
const at = '2026-09-28T07:33:00.000Z';

const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const veraAccount = { id: 1003, is_bot: false, first_name: 'Вера' };
const telegramChatId = '-1001234567890';
const borisTopic = 17;
const veraTopic = 18;
const formulation = 'Смотри https://github.com/org/repo/issues/12 и #12';

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

interface Fixture {
  db: Kysely<Database>;
  close: () => Promise<void>;
  alphaId: string;
  betaId: string;
  borisId: string;
  veraId: string;
}

interface StoredTask {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  assigneeId: string;
  completedAt: Date | null;
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
      refuse: () => undefined,
    },
  };
}

function fakeStore(owners: TopicOwner[]): { store: TaskStore; tasks: Task[] } {
  const tasks: Task[] = [];
  const numbers = new Map<string, number>();
  return {
    tasks,
    store: {
      async ownersOfTopic() {
        return owners;
      },
      async nextNumber(projectId) {
        const next = (numbers.get(projectId) ?? 0) + 1;
        numbers.set(projectId, next);
        return next;
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

async function openDb(): Promise<{ db: Kysely<Database>; close: () => Promise<void> }> {
  const pglite = new PGlite();
  await pglite.exec(readEventsMigration());
  await pglite.exec(readUsersMigration());
  await pglite.exec(readProjectsMigration());
  await pglite.exec(readChatsMigration());
  await pglite.exec(readProjectMembersMigration());
  await pglite.exec(readMemberTopicMigration());
  await pglite.exec(readTasksMigration());
  await pglite.exec(readCanvasesMigration());
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

async function seed(): Promise<Fixture> {
  const handle = await openDb();
  const registration = createUserRegistration(handle.db, silentLogger, clock);
  await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
  const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
  const vera = await registration.registerOnStart({ telegramUserId: String(veraAccount.id), name: veraAccount.first_name });
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
    idempotencyKey: 'add-boris',
  });
  await sql`
    INSERT INTO project_members (id, project_id, user_id, role, topic_id)
    VALUES (${'00000000-0000-4000-8000-0000000000c1'}::uuid, ${alpha.project.id}::uuid, ${vera.user.id}::uuid, ${LEAD_ROLE}, ${veraTopic})
  `.execute(handle.db);
  await sql`
    UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid
  `.execute(handle.db);
  await createChatBinding(handle.db, silentLogger, clock).confirm({
    telegramUserId: String(rootAccount.id),
    projectId: alpha.project.id,
    offer: forumAdmin,
    idempotencyKey: 'bind-alpha',
  });
  return {
    db: handle.db,
    close: handle.close,
    alphaId: alpha.project.id,
    betaId: beta.project.id,
    borisId: boris.user.id,
    veraId: vera.user.id,
  };
}

async function tasksOf(db: Kysely<Database>): Promise<StoredTask[]> {
  const result = await sql<{
    id: string;
    project_id: string;
    number: number;
    title: string;
    status: string;
    priority: string;
    assignee_id: string;
    completed_at: Date | null;
  }>`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      number,
      title,
      status,
      priority,
      assignee_id::text AS assignee_id,
      completed_at
    FROM tasks
    ORDER BY number, project_id::text
  `.execute(db);
  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    number: Number(row.number),
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    completedAt: row.completed_at,
  }));
}

async function createdEvents(db: Kysely<Database>): Promise<{ key: string; payload: unknown; actorId: string; actorRole: string; subject: string }[]> {
  const result = await sql<{
    idempotency_key: string;
    payload: unknown;
    actor_id: string;
    actor_role: string;
    subject_entity: string;
  }>`
    SELECT idempotency_key, payload, actor_id, actor_role, subject_entity
    FROM events
    WHERE event_type = ${EVENT_TYPES.TASK_CREATED}
    ORDER BY idempotency_key
  `.execute(db);
  return result.rows.map((row) => ({
    key: row.idempotency_key,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    subject: row.subject_entity,
    payload: typeof row.payload === 'string' ? (JSON.parse(row.payload) as unknown) : row.payload,
  }));
}

function place(topicId: number | undefined, type = TASK_TOPIC_CHAT, id = telegramChatId) {
  return { type, id, topicId };
}

describe('команда /task в топике исполнителя', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('INV-04 задачу заводит только /task в своём топике; поток GitHub задач не создаёт, текст ссылкой не разбирается', async () => {
    expect(parseTaskCommand('/tasks нет')).toBeNull();
    expect(parseTaskCommand('issue #12')).toBeNull();
    expect(parseTaskCommand('/task')).toBe('');
    expect(parseTaskCommand(`/task@progress_bot ${formulation}`)).toBe(formulation);
    expect(taskFormulation(`  ${formulation}  `)).toBe(formulation);
    expect(formulation).toContain('github.com');
    expect(formulation).toContain('#12');

    const lead: TopicOwner = { projectId: 'project-1', userId: 'user-vera', name: 'Альфа', role: TASK_ASSIGNEE_LEAD };
    const stranger = fakeStore([lead]);
    const journal = memoryJournal();
    await expect(
      createTask(stranger.store, journal.journal, clock, {
        id: 'task-stranger',
        title: formulation,
        sender: { id: 'user-boris' },
        chat: TASK_TOPIC_CHAT,
        telegramChatId,
        topicId: veraTopic,
        idempotencyKey: 'stranger',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_PLACE });
    expect(stranger.tasks).toEqual([]);

    const viewer = fakeStore([{ projectId: 'project-1', userId: 'user-boris', name: 'Альфа', role: 'viewer' }]);
    await expect(
      createTask(viewer.store, journal.journal, clock, {
        id: 'task-viewer',
        title: formulation,
        sender: { id: 'user-boris' },
        chat: TASK_TOPIC_CHAT,
        telegramChatId,
        topicId: borisTopic,
        idempotencyKey: 'viewer',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_ASSIGNEE_ROLE });
    expect(viewer.tasks).toEqual([]);
    expect(journal.rows).toEqual([]);

    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskActions(fixture.db, silentLogger, clock);
    const created = await replyToTaskCommand(place(borisTopic), borisAccount, '401', formulation, actions);
    expect(created).toBe(taskCreatedReply(1, formulation));
    const foreign = await replyToTaskCommand(place(veraTopic), borisAccount, '402', formulation, actions);
    expect(foreign).toBe(TASK_OWN_TOPIC);
    const privateChat = await replyToTaskCommand(place(borisTopic, 'private', '1002'), borisAccount, '403', formulation, actions);
    expect(privateChat).toBe(TASK_OWN_TOPIC);
    const general = await replyToTaskCommand(place(undefined), borisAccount, '404', formulation, actions);
    expect(general).toBe(TASK_OWN_TOPIC);
    const empty = await replyToTaskCommand(place(borisTopic), borisAccount, '405', '   ', actions);
    expect(empty).toBe(TASK_NEEDS_TITLE);

    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      source: 'github',
      idempotencyKey: 'gh-issue',
      payload: {
        repository_id: 'repo-1',
        issue_number: 12,
        title: formulation,
        state: 'open',
        state_reason: null,
        assignees: ['boris'],
        closed_by_login: null,
        updated_at: at,
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Issue', id: '12' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
      source: 'github',
      idempotencyKey: 'gh-pr',
      payload: {
        repository_id: 'repo-1',
        pull_request_number: 3,
        title: 'PR',
        state: 'open',
        author_login: 'boris',
        updated_at: at,
        merged_at: null,
        merged_by_login: null,
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'PullRequest', id: '3' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.GITHUB_COMMITS_PUSHED,
      source: 'github',
      idempotencyKey: 'gh-commits',
      payload: {
        repository_id: 'repo-1',
        commits: [{ sha: 'abc', author_login: 'boris', message: formulation, created_at: at }],
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Repository', id: 'repo-1' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });

    const stored = await tasksOf(fixture.db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      projectId: fixture.alphaId,
      number: 1,
      title: formulation,
      status: TASK_STATUS_IN_PROGRESS,
      assigneeId: fixture.borisId,
      completedAt: null,
    });
    expect(Object.keys(stored[0] ?? {})).not.toContain('issue');

    const writers = tsFiles('src').filter((file) => readFileSync(file, 'utf8').includes("insertInto('tasks')"));
    expect(writers).toEqual(['src/infrastructure/tasks.ts']);
    const githubSeesTasks = tsFiles('src/github').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('domain/tasks') || text.includes('infrastructure/tasks');
    });
    expect(githubSeesTasks).toEqual([]);
  });

  it('INV-05 новая задача одна и в статусе IN_PROGRESS; события GitHub статус не меняют', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskActions(fixture.db, silentLogger, clock);
    await replyToTaskCommand(place(veraTopic), veraAccount, '501', 'Ждёт руководителя', actions);
    const before = await tasksOf(fixture.db);
    expect(before).toEqual([
      expect.objectContaining({
        status: TASK_STATUS_IN_PROGRESS,
        assigneeId: fixture.veraId,
        priority: DEFAULT_PRIORITY,
      }),
    ]);
    expect(new Set(before.map((task) => task.status))).toEqual(new Set([TASK_STATUS_IN_PROGRESS]));
    await emit(createEventJournal(fixture.db, silentLogger), {
      type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      source: 'github',
      idempotencyKey: 'gh-status',
      payload: {
        repository_id: 'repo-1',
        issue_number: 1,
        title: 'закрыли',
        state: 'closed',
        state_reason: 'completed',
        assignees: ['vera'],
        closed_by_login: 'vera',
        updated_at: at,
      },
      actor: { id: 'github', role: 'github' },
      subject: { entity: 'Issue', id: '1' },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    const after = await tasksOf(fixture.db);
    expect(after.map((task) => task.status)).toEqual([TASK_STATUS_IN_PROGRESS]);
    expect(after).toHaveLength(1);
  });

  it('INV-08 приоритет новой задачи — значение по умолчанию normal', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const created = await createTaskActions(fixture.db, silentLogger, clock).create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Обычная',
      idempotencyKey: '801',
    });
    expect(DEFAULT_PRIORITY).toBe('normal');
    expect(created.task.priority).toBe(DEFAULT_PRIORITY);
    expect(created.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    const [stored] = await tasksOf(fixture.db);
    expect(stored?.priority).toBe(DEFAULT_PRIORITY);
    const [event] = await createdEvents(fixture.db);
    expect(event?.payload).toMatchObject({ priority: DEFAULT_PRIORITY, title: 'Обычная', number: 1 });
  });

  it('INV-22 тот же update не создаёт вторую задачу и не пишет второе событие', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskActions(fixture.db, silentLogger, clock);
    const first = await replyToTaskCommand(place(borisTopic), borisAccount, '901', 'Первая', actions);
    const second = await replyToTaskCommand(place(borisTopic), borisAccount, '901', 'Вторая', actions);
    expect(first).toBe(taskCreatedReply(1, 'Первая'));
    expect(second).toBeNull();
    const stored = await tasksOf(fixture.db);
    expect(stored.map((task) => task.title)).toEqual(['Первая']);
    const events = await createdEvents(fixture.db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: '901',
      actorId: fixture.borisId,
      actorRole: TASK_ACTOR_ROLE,
      subject: TASK_SUBJECT,
    });
    await expect(
      actions.create({
        telegramUserId: String(borisAccount.id),
        chat: TASK_TOPIC_CHAT,
        telegramChatId,
        topicId: borisTopic,
        title: 'Без ключа',
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({ code: DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY });
    expect(await tasksOf(fixture.db)).toHaveLength(1);
  });

  it('номер уникален в проекте и следующий берётся после наибольшего; lead тоже заводит задачу', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const actions = createTaskActions(fixture.db, silentLogger, clock);
    await actions.create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Раз',
      idempotencyKey: 'n-1',
    });
    const second = await actions.create({
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
      title: 'Два',
      idempotencyKey: 'n-2',
    });
    expect(second.task.number).toBe(2);
    expect(second.task.assigneeId).toBe(fixture.borisId);
    const lead = await actions.create({
      telegramUserId: String(veraAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: veraTopic,
      title: 'Три',
      idempotencyKey: 'n-3',
    });
    expect(lead.task.number).toBe(3);
    expect(lead.task.assigneeId).toBe(fixture.veraId);
    await expect(sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES (
        ${'00000000-0000-4000-8000-0000000000d1'}::uuid,
        ${fixture.alphaId}::uuid,
        2,
        'Дубль',
        ${TASK_STATUS_IN_PROGRESS},
        ${DEFAULT_PRIORITY},
        ${fixture.borisId}::uuid,
        ${at}::timestamptz,
        ${at}::timestamptz
      )
    `.execute(fixture.db)).rejects.toThrow(/tasks_project_number_unique|duplicate key|23505/);
    await sql`
      INSERT INTO tasks (id, project_id, number, title, status, priority, assignee_id, created_at, updated_at)
      VALUES (
        ${'00000000-0000-4000-8000-0000000000d2'}::uuid,
        ${fixture.betaId}::uuid,
        2,
        'В другом проекте',
        ${TASK_STATUS_IN_PROGRESS},
        ${DEFAULT_PRIORITY},
        ${fixture.borisId}::uuid,
        ${at}::timestamptz,
        ${at}::timestamptz
      )
    `.execute(fixture.db);
    const numbers = await tasksOf(fixture.db);
    expect(numbers.filter((task) => task.projectId === fixture.alphaId).map((task) => task.number)).toEqual([1, 2, 3]);
    expect(numbers.filter((task) => task.projectId === fixture.betaId).map((task) => task.number)).toEqual([2]);
  });
});

describe('бот заводит задачу по /task', () => {
  const sent: string[] = [];
  const opened: { close: () => Promise<void> }[] = [];
  let running: RunningProcess | undefined;

  afterAll(async () => {
    await running?.stop();
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  function captureReplies(target: string[]): Transformer {
    return (async (_prev, method, payload) => {
      if (method === 'sendMessage' && 'text' in payload && typeof payload.text === 'string') target.push(payload.text);
      if (method === 'sendMessage' || method === 'sendRichMessage') {
        return {
          ok: true,
          result: {
            message_id: target.length + 1,
            date: 1,
            chat: { id: 1, type: 'supergroup' },
            rich_message: { blocks: [] },
          },
        };
      }
      return { ok: true, result: true };
    }) as Transformer;
  }

  it('команда в топике пишет задачу и отвечает номером и названием', async () => {
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
    running.bot.api.config.use(captureReplies(sent));
    const body = JSON.stringify({
      update_id: 910,
      message: {
        message_id: 910,
        date: 1700000000,
        message_thread_id: borisTopic,
        chat: { id: Number(telegramChatId), type: 'supergroup' },
        from: borisAccount,
        text: '/task Сверстать отчёт',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    });
    const status = await httpStatus(running.port, 'POST', TELEGRAM_WEBHOOK_PATH, body, {
      'X-Telegram-Bot-Api-Secret-Token': 'secret',
    });
    expect(status).toBe(200);
    expect(sent).toEqual([taskCreatedReply(1, 'Сверстать отчёт')]);
    const stored = await tasksOf(fixture.db);
    expect(stored.map((task) => task.title)).toEqual(['Сверстать отчёт']);
    expect(stored[0]?.assigneeId).toBe(fixture.borisId);
  });

  it('R-980 R-981 в одном топике несколько канвасов: задача появляется после кнопки проекта', async () => {
    const fixture = await seed();
    opened.push(fixture);
    const membership = createMembership(fixture.db, silentLogger, clock);
    await membership.add({
      telegramUserId: String(rootAccount.id),
      projectId: fixture.betaId,
      targetTelegramUserId: String(borisAccount.id),
      chat: 'private',
      idempotencyKey: 'add-boris-beta',
    });
    await createChatBinding(fixture.db, silentLogger, clock).confirm({
      telegramUserId: String(rootAccount.id),
      projectId: fixture.betaId,
      offer: forumAdmin,
      idempotencyKey: 'bind-beta',
    });
    await sql`
      UPDATE project_members
      SET topic_id = ${borisTopic}
      WHERE user_id = ${fixture.borisId}::uuid AND project_id = ${fixture.betaId}::uuid
    `.execute(fixture.db);

    const actions = createTaskActions(fixture.db, silentLogger, clock);
    const offered = await replyToTaskCommand(place(borisTopic), borisAccount, '501', formulation, actions);
    expect(offered).not.toBe(TASK_OWN_TOPIC);
    if (offered === null || typeof offered === 'string') throw new Error('кнопок нет');
    expect(offered.text).toBe(TASK_PICK_PROJECT);
    expect(offered.projects).toEqual([
      { projectId: fixture.alphaId, name: 'Альфа' },
      { projectId: fixture.betaId, name: 'Бета' },
    ]);
    const rows = taskProjectKeyboard(offered.projects).inline_keyboard;
    expect(rows.map((row) => row[0]?.text)).toEqual(['Альфа', 'Бета']);
    const betaButton = rows[1]?.[0];
    if (betaButton === undefined || !('callback_data' in betaButton)) throw new Error('кнопки нет');
    expect(parseTaskProjectData(betaButton.callback_data)).toBe(fixture.betaId);
    expect(await tasksOf(fixture.db)).toEqual([]);
    expect(await createdEvents(fixture.db)).toEqual([]);

    const redraws: string[] = [];
    const title = parseTaskCommand(`/task ${formulation}`);
    const created = await replyToTaskProject(
      place(borisTopic),
      borisAccount,
      'cb-beta',
      title ?? '',
      fixture.betaId,
      actions,
      {
        async redraw(input) {
          redraws.push(input.projectId);
        },
      },
    );
    expect(created).toBe(taskCreatedReply(1, formulation));
    const tasks = await tasksOf(fixture.db);
    expect(tasks.map((task) => ({ projectId: task.projectId, title: task.title }))).toEqual([
      { projectId: fixture.betaId, title: formulation },
    ]);
    expect(redraws).toEqual([fixture.betaId]);

    const stolen = await replyToTaskProject(place(borisTopic), veraAccount, 'cb-vera', formulation, fixture.alphaId, actions);
    expect(stolen).toBe(TASK_OWN_TOPIC);
    expect(await tasksOf(fixture.db)).toHaveLength(1);
  });
});
