import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import {
  addProjectMember,
  describeMemberRemoval,
  listParticipants,
  removeProjectMember,
  type MembershipActions,
  type MembershipStore,
  type ProjectMemberView,
} from '../domain/projects/membership.ts';
import { MEMBER_ROLE } from '../domain/projects/member.ts';
import type { User } from '../domain/projects/user.ts';
import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { TASK_STATUS_CANCELLED, TASK_STATUS_DONE } from '../domain/tasks/status.ts';
import type { Database } from './database.ts';
import { createEventJournal } from './event-journal.ts';
import { cancelRemovedMemberTasks } from './tasks.ts';

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`${label} повреждён`);
}

function userOf(row: {
  id: string;
  telegram_user_id: string;
  github_login: string | null;
  name: string;
  is_root: boolean;
}): User {
  return {
    id: row.id,
    telegramUserId: asText(row.telegram_user_id, 'telegram_user_id'),
    githubLogin: row.github_login,
    name: row.name,
    isRoot: row.is_root,
  };
}

async function findUser(trx: Transaction<Database>, telegramUserId: string): Promise<User | null> {
  const row = await trx
    .selectFrom('users')
    .select(['id', 'telegram_user_id', 'github_login', 'name', 'is_root'])
    .where('telegram_user_id', '=', telegramUserId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return userOf(row);
}

function memberOf(row: {
  id: string;
  project_id: string;
  user_id: string;
  role: 'member' | 'lead';
  name: string;
  telegram_user_id: string;
}): ProjectMemberView {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    name: row.name,
    telegramUserId: asText(row.telegram_user_id, 'telegram_user_id'),
  };
}

function storeOf(trx: Transaction<Database>): MembershipStore {
  return {
    async hasMembership(userId) {
      const row = await trx.selectFrom('project_members').select('id').where('user_id', '=', userId).executeTakeFirst();
      return row !== undefined;
    },
    async projectsNamed(name) {
      const rows = await trx.selectFrom('projects').select(['id', 'name']).where('name', '=', name).orderBy('id').execute();
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    async projectExists(projectId) {
      const row = await trx.selectFrom('projects').select('id').where('id', '=', projectId).executeTakeFirst();
      return row !== undefined;
    },
    async candidates(projectId) {
      const rows = await trx
        .selectFrom('users')
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('project_members')
                .select('project_members.id')
                .whereRef('project_members.user_id', '=', 'users.id')
                .where('project_members.project_id', '=', projectId),
            ),
          ),
        )
        .select(['users.id', 'users.telegram_user_id', 'users.github_login', 'users.name', 'users.is_root'])
        .orderBy('users.name')
        .orderBy('users.id')
        .execute();
      return rows.map((row) => userOf(row));
    },
    async members(projectId) {
      const rows = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .select([
          'project_members.id',
          'project_members.project_id',
          'project_members.user_id',
          'project_members.role',
          'users.name',
          'users.telegram_user_id',
        ])
        .orderBy('users.name')
        .orderBy('project_members.id')
        .execute();
      return rows.map((row) => memberOf(row));
    },
    async findMember(projectId, userId) {
      const row = await trx
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .where('project_members.project_id', '=', projectId)
        .where('project_members.user_id', '=', userId)
        .select([
          'project_members.id',
          'project_members.project_id',
          'project_members.user_id',
          'project_members.role',
          'users.name',
          'users.telegram_user_id',
        ])
        .executeTakeFirst();
      if (row === undefined) return null;
      return memberOf(row);
    },
    async insert(member) {
      await trx
        .insertInto('project_members')
        .values({
          id: member.id,
          project_id: member.projectId,
          user_id: member.userId,
          role: member.role,
        })
        .execute();
    },
    async deleteMember(memberId) {
      await trx.deleteFrom('project_members').where('id', '=', memberId).execute();
    },
    async unclosedTaskIds(projectId, userId) {
      const rows = await trx
        .selectFrom('tasks')
        .select(['id'])
        .where('project_id', '=', projectId)
        .where('assignee_id', '=', userId)
        .where('status', 'not in', [TASK_STATUS_DONE, TASK_STATUS_CANCELLED])
        .orderBy('id')
        .forUpdate()
        .execute();
      return rows.map((row) => row.id);
    },
  };
}

/** Состав проекта: экран, добавление и удаление коммитятся одной транзакцией со событием. */
export function createMembership(db: Kysely<Database>, logger: Logger, clock: Clock): MembershipActions {
  return {
    open(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        return listParticipants(storeOf(trx), {
          actor,
          projectName: input.projectName,
          chat: input.chat,
        });
      });
    },
    add(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        if (target === null) throw new DomainError(DOMAIN_ERROR.MEMBER_NOT_CANDIDATE, 'человек не найден');
        const member = await addProjectMember(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          chat: input.chat,
          projectId: input.projectId,
          target,
          memberId: randomUUID(),
          idempotencyKey: input.idempotencyKey,
        });
        if (member.role !== MEMBER_ROLE) throw new DomainError(DOMAIN_ERROR.PROJECT_ROLE, 'роль добавления — member');
        const project = await trx.selectFrom('projects').select('name').where('id', '=', input.projectId).executeTakeFirst();
        if (project === undefined) throw new DomainError(DOMAIN_ERROR.MEMBER_PROJECT_MISSING, 'проект не найден');
        return { name: target.name, role: member.role, projectName: project.name };
      });
    },
    describeRemoval(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        const member = await describeMemberRemoval(storeOf(trx), {
          actor,
          chat: input.chat,
          projectId: input.projectId,
          target,
        });
        return { name: member.name };
      });
    },
    remove(input) {
      return db.transaction().execute(async (trx) => {
        const actor = await findUser(trx, input.telegramUserId);
        const target = await findUser(trx, input.targetTelegramUserId);
        if (target === null) throw new DomainError(DOMAIN_ERROR.MEMBER_ABSENT, 'человек не найден');
        const idempotencyKey = input.idempotencyKey.trim();
        const cancelledTaskIds = await removeProjectMember(storeOf(trx), createEventJournal(trx, logger), clock, {
          actor,
          chat: input.chat,
          projectId: input.projectId,
          target,
          idempotencyKey,
        });
        const removed = await trx
          .selectFrom('events')
          .select(['id'])
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (removed === undefined) throw new Error('project.member_removed не найден');
        await cancelRemovedMemberTasks(trx, logger, clock, {
          causationId: removed.id,
          projectId: input.projectId,
          assigneeId: target.id,
          taskIds: cancelledTaskIds,
        });
        return { name: target.name, cancelledTaskIds };
      });
    },
  };
}
