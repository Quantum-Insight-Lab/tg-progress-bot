import { emit, EVENT_TYPES, type EmitResult, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { TASK_ACTOR_ROLE, TASK_ASSIGNEE_LEAD, TASK_SOURCE, TASK_SUBJECT, TASK_TOPIC_CHAT } from './create-task.ts';
import { defineUnlinked } from './github-link.ts';
import type { TaskStatus } from './status.ts';
import type { Task } from './task.ts';
import { TASK_TRANSITION_CANCEL, transitionTask } from './transition.ts';

/** Кнопка «отменить». */
export const TASK_CANCEL_REASON_BUTTON = 'button';

/** Следствие `project.member_removed`. */
export const TASK_CANCEL_REASON_MEMBER = 'member_removed';

/** Снятие при удалении участника пишет система, не человек. */
export const TASK_CANCEL_SYSTEM_ACTOR = 'system';

export const TASK_CANCEL_SYSTEM_ROLE = 'system';

export const TASK_CANCEL_SYSTEM_SOURCE = 'system';

/**
 * Порт «отменить» внутри уже открытой транзакции.
 * Роль приходит строкой: контекст проектов сюда не импортируется.
 */
export interface TaskCancelStore {
  sender(telegramUserId: string): Promise<{ id: string } | null>;
  tasksInTopic(telegramChatId: string, topicId: number, taskNumber: number): Promise<Task[]>;
  membership(projectId: string, userId: string): Promise<{ role: string } | null>;
  /** Уже записанный ключ. Повтор не переводит статус заново. */
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

/** Нажатие «отменить». Ключ — `callback_query_id`. */
export interface TaskCancelPress {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  taskNumber: number;
  idempotencyKey: string;
}

export interface TaskCancelResult {
  task: Task;
  eventId: string;
  /** Повтор того же callback статус не меняет. */
  applied: boolean;
  closesBlocker: boolean;
}

export interface TaskCancelling {
  press(input: TaskCancelPress): Promise<TaskCancelResult>;
}

/** Задачи, которые `project.member_removed` уже перечислил. */
export interface RemovedMemberTasks {
  causationId: string;
  projectId: string;
  assigneeId: string;
  taskIds: readonly string[];
}

/**
 * Порт снятия задач удалённого участника.
 * Список id приходит из события удаления, контекст проектов сюда не импортируется.
 */
export interface TaskRemovalStore {
  tasksOfAssignee(projectId: string, assigneeId: string, taskIds: readonly string[]): Promise<Task[]>;
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

export interface RemovedMemberCancelResult {
  eventIds: string[];
}

/** Ключ `task.cancelled` после удаления участника: событие удаления и задача. */
export function memberRemovedCancelKey(memberRemovedEventId: string, taskId: string): string {
  return `${memberRemovedEventId}+${taskId}`;
}

function cancelActor(senderId: string, assigneeId: string, role: string | null): string {
  if (senderId === assigneeId) return TASK_ACTOR_ROLE;
  if (role === TASK_ASSIGNEE_LEAD) return TASK_ASSIGNEE_LEAD;
  throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ACTOR, 'снять задачу может руководитель или исполнитель');
}

function publishCancel(
  journal: EventJournal,
  input: {
    source: string;
    idempotencyKey: string;
    taskId: string;
    actorId: string;
    actorRole: string;
    cancelledBy: string;
    reason: typeof TASK_CANCEL_REASON_BUTTON | typeof TASK_CANCEL_REASON_MEMBER;
    occurredAt: Date;
    causationId: string | null;
  },
): Promise<EmitResult> {
  return emit(journal, {
    type: EVENT_TYPES.TASK_CANCELLED,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    payload: {
      task_id: input.taskId,
      cancelled_by: input.cancelledBy,
      reason: input.reason,
    },
    actor: { id: input.actorId, role: input.actorRole },
    subject: { entity: TASK_SUBJECT, id: input.taskId },
    occurredAt: input.occurredAt,
    causationId: input.causationId,
    correlationId: null,
  });
}

async function taskNow(store: TaskCancelStore, telegramChatId: string, topicId: number, taskNumber: number, fallback: Task): Promise<Task> {
  const again = await store.tasksInTopic(telegramChatId, topicId, taskNumber);
  const current = again.length === 1 ? again[0] : fallback;
  if (current === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ABSENT, 'задачи с этим номером в топике нет');
  }
  return current;
}

/**
 * «Отменить» переводит задачу в `CANCELLED`.
 * Нажимает исполнитель этой задачи или руководитель проекта. Пока задача не `DONE`.
 * Повтор того же callback второго события не пишет. Событие GitHub сюда не входит.
 */
export async function pressTaskCancel(
  store: TaskCancelStore,
  journal: EventJournal,
  clock: Clock,
  input: TaskCancelPress,
): Promise<TaskCancelResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const topicId = input.topicId;
  if (input.chat !== TASK_TOPIC_CHAT || topicId === null || !Number.isInteger(topicId) || topicId <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'кнопка нажимается в топике исполнителя');
  }
  if (!Number.isInteger(input.taskNumber) || input.taskNumber <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_NUMBER, 'номер задачи — целое число внутри проекта');
  }
  const sender = await store.sender(input.telegramUserId);
  if (sender === null) {
    throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ACTOR, 'снять задачу может руководитель или исполнитель');
  }
  const found = await store.tasksInTopic(input.telegramChatId, topicId, input.taskNumber);
  if (found.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ABSENT, 'задачи с этим номером в топике нет');
  }
  if (found.length > 1) {
    throw new DomainError(DOMAIN_ERROR.TASK_AMBIGUOUS, 'топик совпал у нескольких проектов');
  }
  const task = found[0];
  if (task === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ABSENT, 'задачи с этим номером в топике нет');
  }
  const member = await store.membership(task.projectId, sender.id);
  const actorRole = cancelActor(sender.id, task.assigneeId, member === null ? null : member.role);
  const prior = await store.seen(idempotencyKey);
  if (prior !== null) {
    return { task, eventId: prior.eventId, applied: false, closesBlocker: false };
  }
  const move = transitionTask(task.status, TASK_TRANSITION_CANCEL);
  const now = clock.now();
  const published = await publishCancel(journal, {
    source: TASK_SOURCE,
    idempotencyKey,
    taskId: task.id,
    actorId: sender.id,
    actorRole,
    cancelledBy: sender.id,
    reason: TASK_CANCEL_REASON_BUTTON,
    occurredAt: now,
    causationId: null,
  });
  if (published.status === 'duplicate') {
    const current = await taskNow(store, input.telegramChatId, topicId, input.taskNumber, task);
    return { task: current, eventId: published.row.id, applied: false, closesBlocker: false };
  }
  const next = defineUnlinked({ ...task, status: move.to, updatedAt: now.toISOString(), completedAt: null });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  return { task: next, eventId: published.row.id, applied: true, closesBlocker: move.closesBlocker };
}

function requireTask(tasks: readonly Task[], id: string, projectId: string, assigneeId: string): Task {
  const found = tasks.filter((task) => task.id === id);
  const task = found.length === 1 ? found[0] : undefined;
  if (task === undefined || task.projectId !== projectId || task.assigneeId !== assigneeId) {
    throw new DomainError(DOMAIN_ERROR.TASK_CANCEL_ABSENT, 'незакрытая задача участника не найдена');
  }
  return task;
}

/**
 * Реакция на `project.member_removed`: незакрытые задачи этого участника становятся `CANCELLED`.
 * Вызывается в той же транзакции, что и удаление. Повтор ключа второе событие не пишет.
 */
export async function cancelTasksOfRemovedMember(
  store: TaskRemovalStore,
  journal: EventJournal,
  clock: Clock,
  input: RemovedMemberTasks,
): Promise<RemovedMemberCancelResult> {
  const causationId = input.causationId.trim();
  if (causationId.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  if (input.taskIds.length === 0) return { eventIds: [] };
  const loaded = await store.tasksOfAssignee(input.projectId, input.assigneeId, input.taskIds);
  const now = clock.now();
  const eventIds: string[] = [];
  for (const taskId of input.taskIds) {
    const task = requireTask(loaded, taskId, input.projectId, input.assigneeId);
    const idempotencyKey = memberRemovedCancelKey(causationId, task.id);
    const prior = await store.seen(idempotencyKey);
    if (prior !== null) {
      eventIds.push(prior.eventId);
      continue;
    }
    const move = transitionTask(task.status, TASK_TRANSITION_CANCEL);
    const published = await publishCancel(journal, {
      source: TASK_CANCEL_SYSTEM_SOURCE,
      idempotencyKey,
      taskId: task.id,
      actorId: TASK_CANCEL_SYSTEM_ACTOR,
      actorRole: TASK_CANCEL_SYSTEM_ROLE,
      cancelledBy: TASK_CANCEL_SYSTEM_ACTOR,
      reason: TASK_CANCEL_REASON_MEMBER,
      occurredAt: now,
      causationId,
    });
    if (published.status === 'duplicate') {
      eventIds.push(published.row.id);
      continue;
    }
    const next = defineUnlinked({ ...task, status: move.to, updatedAt: now.toISOString(), completedAt: null });
    const saved = await store.saveStatus(next, move.from);
    if (!saved) {
      throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
    }
    eventIds.push(published.row.id);
  }
  return { eventIds };
}
