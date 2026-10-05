import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupergroupOffer } from '../src/domain/projects/chat.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { TASK_TOPIC_CHAT } from '../src/domain/tasks/create-task.ts';
import { TASK_STATUS_BLOCKED, TASK_STATUS_IN_PROGRESS } from '../src/domain/tasks/status.ts';
import type { Database } from '../src/infrastructure/database.ts';
import { assumeJournalRole } from '../src/infrastructure/db.ts';
import { createChatBinding } from '../src/infrastructure/chats.ts';
import { rememberBlockerQuestion } from '../src/infrastructure/detect-blocker.ts';
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
import { createBlockerAnswerActions, createTaskActions } from '../src/infrastructure/tasks.ts';
import { createUserRegistration } from '../src/infrastructure/users.ts';
import { blockerQuestionText, parseBlockerQuestion } from '../src/projections/blocker-question.ts';
import { replyToBlockerReason, replyToNoBlocker } from '../src/telegram/blocker-answer.ts';
import { silentLogger } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-10-05T05:00:00.000Z') };
const at = '2026-10-05T05:00:00.000Z';
const rootAccount = { id: 1001, is_bot: false, first_name: 'Аня' };
const borisAccount = { id: 1002, is_bot: false, first_name: 'Борис' };
const telegramChatId = '-1001234567890';
const borisTopic = 17;
const alphaMessage = 501;
const betaMessage = 502;
const alphaBlockerId = '00000000-0000-4000-8000-0000000000a1';
const betaBlockerId = '00000000-0000-4000-8000-0000000000b1';

const forumAdmin: SupergroupOffer = {
  telegramChatId,
  kind: 'supergroup',
  forum: true,
  canPostMessages: true,
  canManageTopics: true,
};

describe('вопрос о блокере', () => {
  const opened: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((item) => item.close()));
  });

  it('R-1011 в вопросе о блокере, кроме номера, стоит имя проекта', () => {
    const text = blockerQuestionText(1, 3, 'ЭКГ-патч');
    expect(text).toBe('ЭКГ-патч: 1 не двигается 3-й день, что мешает?');
    expect(parseBlockerQuestion(text)).toEqual({ taskNumber: 1, day: 3 });
    expect(blockerQuestionText(7, 3)).toBe('7 не двигается 3-й день, что мешает?');
  });

  it('INV-11 R-1012 R-1013 R-1014 R-1015 вопрос относится к задаче, о которой задан', async () => {
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
    opened.push({ close: () => db.destroy() });

    const registration = createUserRegistration(db, silentLogger, clock);
    await registration.registerOnStart({ telegramUserId: String(rootAccount.id), name: rootAccount.first_name });
    const boris = await registration.registerOnStart({ telegramUserId: String(borisAccount.id), name: borisAccount.first_name });
    const creation = createProjectCreation(db, silentLogger, clock);
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
    const membership = createMembership(db, silentLogger, clock);
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
    await sql`UPDATE project_members SET topic_id = ${borisTopic} WHERE user_id = ${boris.user.id}::uuid`.execute(db);
    const binding = createChatBinding(db, silentLogger, clock);
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
    const drafting = createTaskActions(db, silentLogger, clock);
    const draft = {
      telegramUserId: String(borisAccount.id),
      chat: TASK_TOPIC_CHAT,
      telegramChatId,
      topicId: borisTopic,
    };
    const alphaTask = await drafting.pick({ ...draft, projectId: alpha.project.id, title: 'Альфа', idempotencyKey: 'task-alpha' });
    const betaTask = await drafting.pick({ ...draft, projectId: beta.project.id, title: 'Бета', idempotencyKey: 'task-beta' });
    await sql`UPDATE tasks SET status = ${TASK_STATUS_BLOCKED} WHERE id IN (${alphaTask.task.id}::uuid, ${betaTask.task.id}::uuid)`.execute(db);
    await sql`
      INSERT INTO blockers (id, task_id, reason, asked_at)
      VALUES
        (${alphaBlockerId}::uuid, ${alphaTask.task.id}::uuid, NULL, ${at}::timestamptz),
        (${betaBlockerId}::uuid, ${betaTask.task.id}::uuid, NULL, ${at}::timestamptz)
    `.execute(db);
    await rememberBlockerQuestion(db, alphaBlockerId, alphaMessage);
    await rememberBlockerQuestion(db, alphaBlockerId, 999);
    await rememberBlockerQuestion(db, betaBlockerId, betaMessage);
    const stored = await sql<{ id: string; message_id: string | number }>`
      SELECT id::text AS id, message_id FROM blockers ORDER BY id
    `.execute(db);
    expect(stored.rows.map((row) => ({ id: row.id, messageId: Number(row.message_id) }))).toEqual([
      { id: alphaBlockerId, messageId: alphaMessage },
      { id: betaBlockerId, messageId: betaMessage },
    ]);

    const actions = createBlockerAnswerActions(db, silentLogger, clock);
    const place = { type: TASK_TOPIC_CHAT, id: telegramChatId, topicId: borisTopic };
    const declared = await replyToBlockerReason(
      place,
      borisAccount,
      'update-alpha',
      'ждёт схему',
      { messageId: alphaMessage, text: blockerQuestionText(1, 3, 'Альфа'), fromBot: true },
      actions,
    );
    expect(declared?.task.projectId).toBe(alpha.project.id);
    expect(declared?.blocker.reason).toBe('ждёт схему');
    const reasons = await sql<{ task_id: string; reason: string | null; status: string }>`
      SELECT blockers.task_id::text AS task_id, blockers.reason, tasks.status
      FROM blockers
      JOIN tasks ON tasks.id = blockers.task_id
    `.execute(db);
    expect(reasons.rows.find((row) => row.task_id === alphaTask.task.id)).toMatchObject({
      reason: 'ждёт схему',
      status: TASK_STATUS_BLOCKED,
    });
    expect(reasons.rows.find((row) => row.task_id === betaTask.task.id)).toMatchObject({
      reason: null,
      status: TASK_STATUS_BLOCKED,
    });

    const dismissed = await replyToNoBlocker(
      { ...place, messageId: betaMessage },
      borisAccount,
      'cb-beta',
      1,
      actions,
    );
    expect(dismissed?.task.projectId).toBe(beta.project.id);
    expect(dismissed?.task.status).toBe(TASK_STATUS_IN_PROGRESS);
    const after = await sql<{ id: string; status: string; reason: string | null }>`
      SELECT tasks.id::text AS id, tasks.status, blockers.reason
      FROM tasks
      JOIN blockers ON blockers.task_id = tasks.id
    `.execute(db);
    expect(after.rows.find((row) => row.id === alphaTask.task.id)).toMatchObject({
      status: TASK_STATUS_BLOCKED,
      reason: 'ждёт схему',
    });
    expect(after.rows.find((row) => row.id === betaTask.task.id)?.status).toBe(TASK_STATUS_IN_PROGRESS);
  });
});
