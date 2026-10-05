import { emit, EVENT_TYPES, type EmitResult, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { taskOfCanvasButton, type CanvasButtonLookup } from './canvas-button.ts';
import { TASK_ASSIGNEE_LEAD, TASK_SOURCE, TASK_SUBJECT, TASK_TOPIC_CHAT } from './create-task.ts';
import { type GithubFact, tasksFromGithub } from './github-origin.ts';
import { defineUnlinked } from './github-link.ts';
import { TASK_STATUS_DONE, type TaskStatus } from './status.ts';
import type { Task } from './task.ts';
import { TASK_TRANSITION_CONFIRM, TASK_TRANSITION_RETURN, transitionTask } from './transition.ts';

/**
 * Порт подтверждения внутри уже открытой транзакции.
 * Роль и число руководителей приходят строкой и числом: контекст проектов сюда не импортируется.
 */
export interface TaskReviewStore extends CanvasButtonLookup {
  sender(telegramUserId: string): Promise<{ id: string } | null>;
  membership(projectId: string, userId: string): Promise<{ role: string } | null>;
  leadCount(projectId: string): Promise<number>;
  openBlocker(taskId: string): Promise<boolean>;
  /** Уже записанный ключ. Повтор не переводит статус заново. */
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

/** Нажатие «подтвердить» или «вернуть». Ключ — `callback_query_id`. */
export interface TaskReviewPress {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  messageId?: number;
  taskNumber: number;
  act: string;
  idempotencyKey: string;
}

export interface TaskReviewResult {
  task: Task;
  eventId: string;
  /** Повтор того же callback статус не меняет. */
  applied: boolean;
  closesBlocker: boolean;
}

export interface TaskReviewing {
  press(input: TaskReviewPress): Promise<TaskReviewResult>;
}

/** Роль руководителя в `task.confirmed` и `task.returned`. */
export const TASK_LEAD_ACTOR_ROLE = TASK_ASSIGNEE_LEAD;

/**
 * Смерженный PR, закрытый issue и зелёный CI подтверждением не являются.
 * Поток фактов GitHub задачу не переводит в `DONE`.
 */
export function confirmationFromGithub(facts: readonly GithubFact[]): null {
  tasksFromGithub(facts);
  return null;
}

function publishReview(
  journal: EventJournal,
  act: string,
  input: {
    idempotencyKey: string;
    taskId: string;
    actorId: string;
    occurredAt: Date;
  },
): Promise<EmitResult> {
  const envelope = {
    source: TASK_SOURCE,
    idempotencyKey: input.idempotencyKey,
    actor: { id: input.actorId, role: TASK_LEAD_ACTOR_ROLE },
    subject: { entity: TASK_SUBJECT, id: input.taskId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  };
  if (act === TASK_TRANSITION_CONFIRM) {
    return emit(journal, {
      ...envelope,
      type: EVENT_TYPES.TASK_CONFIRMED,
      payload: { task_id: input.taskId, confirmed_by: input.actorId },
    });
  }
  if (act === TASK_TRANSITION_RETURN) {
    return emit(journal, {
      ...envelope,
      type: EVENT_TYPES.TASK_RETURNED,
      payload: { task_id: input.taskId, returned_by: input.actorId },
    });
  }
  throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
}

/**
 * «Подтвердить» ставит `DONE`, «вернуть» возвращает задачу в `IN_PROGRESS`.
 * Право руководителя проверяет переход. Повтор того же callback второго события не пишет.
 * Смерженный PR, закрытый issue и зелёный CI сюда не входят.
 */
export async function pressTaskReview(
  store: TaskReviewStore,
  journal: EventJournal,
  clock: Clock,
  input: TaskReviewPress,
): Promise<TaskReviewResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  if (input.act !== TASK_TRANSITION_CONFIRM && input.act !== TASK_TRANSITION_RETURN) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
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
    throw new DomainError(DOMAIN_ERROR.TASK_CONFIRM_ACTOR, 'нет права подтверждать');
  }
  const absent = new DomainError(DOMAIN_ERROR.TASK_REVIEW_ABSENT, 'задачи с этим номером в топике нет');
  const located = {
    telegramChatId: input.telegramChatId,
    topicId,
    messageId: input.messageId,
    taskNumber: input.taskNumber,
  };
  const task = await taskOfCanvasButton(store, located, absent);
  const prior = await store.seen(idempotencyKey);
  if (prior !== null) {
    return { task, eventId: prior.eventId, applied: false, closesBlocker: false };
  }
  const member = await store.membership(task.projectId, sender.id);
  const move = transitionTask(task.status, input.act, {
    role: member === null ? '' : member.role,
    actorId: sender.id,
    assigneeId: task.assigneeId,
    leadCount: await store.leadCount(task.projectId),
    openBlocker: await store.openBlocker(task.id),
  });
  const now = clock.now();
  const published = await publishReview(journal, input.act, {
    idempotencyKey,
    taskId: task.id,
    actorId: sender.id,
    occurredAt: now,
  });
  if (published.status === 'duplicate') {
    const current = await taskOfCanvasButton(store, located, absent);
    return { task: current, eventId: published.row.id, applied: false, closesBlocker: false };
  }
  const next = defineUnlinked({
    ...task,
    status: move.to,
    updatedAt: now.toISOString(),
    completedAt: move.to === TASK_STATUS_DONE ? now.toISOString() : null,
  });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  return { task: next, eventId: published.row.id, applied: true, closesBlocker: move.closesBlocker };
}
