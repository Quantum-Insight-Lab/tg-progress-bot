import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  createTask as decideCreate,
  type CreatedTask,
  type TaskCreation,
  type TaskDraft,
  type TaskStore,
  type TopicOwner,
} from '../domain/tasks/create-task.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';

async function findSender(trx: Transaction<Database>, telegramUserId: string): Promise<{ id: string } | null> {
  const row = await trx.selectFrom('users').select(['id']).where('telegram_user_id', '=', telegramUserId).executeTakeFirst();
  if (row === undefined) return null;
  return { id: row.id };
}

function storeOf(trx: Transaction<Database>): TaskStore {
  return {
    async ownersOfTopic(telegramChatId, topicId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('projects', 'projects.id', 'project_members.project_id')
        .innerJoin('chats', 'chats.id', 'projects.chat_id')
        .select(['project_members.project_id', 'project_members.user_id', 'project_members.role'])
        .where('chats.telegram_chat_id', '=', telegramChatId)
        .where('project_members.topic_id', '=', String(topicId))
        .orderBy('project_members.id')
        .execute();
      const owners: TopicOwner[] = rows.map((row) => ({
        projectId: row.project_id,
        userId: row.user_id,
        role: row.role,
      }));
      return owners;
    },
    async nextNumber(projectId) {
      const row = await trx
        .selectFrom('tasks')
        .select('number')
        .where('project_id', '=', projectId)
        .orderBy('number', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      const current = row?.number ?? 0;
      return current + 1;
    },
    async insert(task) {
      await trx
        .insertInto('tasks')
        .values({
          id: task.id,
          project_id: task.projectId,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignee_id: task.assigneeId,
          created_at: new Date(task.createdAt),
          updated_at: new Date(task.updatedAt),
          completed_at: task.completedAt === null ? null : new Date(task.completedAt),
        })
        .execute();
    },
  };
}

/** `/task`: строка `tasks` и `task.created` коммитятся одной транзакцией. */
export function createTaskActions(db: Kysely<Database>, clock: Clock): TaskCreation {
  return {
    create(input: TaskDraft): Promise<CreatedTask> {
      return db.transaction().execute(async (trx) => {
        const sender = await findSender(trx, input.telegramUserId);
        return decideCreate(storeOf(trx), createEventJournal(trx), clock, {
          id: randomUUID(),
          title: input.title,
          sender,
          chat: input.chat,
          telegramChatId: input.telegramChatId,
          topicId: input.topicId,
          idempotencyKey: input.idempotencyKey,
        });
      });
    },
  };
}
