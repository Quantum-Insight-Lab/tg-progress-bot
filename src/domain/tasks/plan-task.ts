import { emit, EVENT_TYPES, type EmitResult, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { taskOfCanvasButton, type CanvasButtonLookup } from './canvas-button.ts';
import { TASK_ACTOR_ROLE, TASK_SOURCE, TASK_SUBJECT, TASK_TOPIC_CHAT } from './create-task.ts';
import { defineUnlinked } from './github-link.ts';
import { nextPriority, prioritySetOnCanvas, type TaskPriority, type TaskStatus } from './status.ts';
import type { Task } from './task.ts';
import { TASK_TRANSITION_PLAN, TASK_TRANSITION_RESUME, transitionTask } from './transition.ts';

/** Нажатие слова приоритета. Это не переход статуса. */
export const TASK_PRIORITY_ACT = 'priority';

/**
 * Порт «в план», «в работу» и слова приоритета внутри уже открытой транзакции.
 * Исполнитель приходит строкой id, контекст проектов сюда не импортируется.
 */
export interface TaskPlanStore extends CanvasButtonLookup {
  sender(telegramUserId: string): Promise<{ id: string } | null>;
  /** Уже записанный ключ. Повтор не меняет задачу заново. */
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
  savePriority(task: Task, from: TaskPriority): Promise<boolean>;
}

/** Нажатие на канвасе. Ключ — `callback_query_id`. */
export interface TaskPlanPress {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  messageId?: number;
  taskNumber: number;
  act: string;
  idempotencyKey: string;
}

export interface TaskPlanResult {
  task: Task;
  eventId: string;
  /** Повтор того же callback задачу не меняет. */
  applied: boolean;
  closesBlocker: boolean;
}

export interface TaskPlanning {
  press(input: TaskPlanPress): Promise<TaskPlanResult>;
}

function assigneeOnly(senderId: string, assigneeId: string): void {
  if (senderId !== assigneeId) {
    throw new DomainError(
      DOMAIN_ERROR.TASK_PLAN_ACTOR,
      '«в план», «в работу» и слово приоритета нажимает только исполнитель',
    );
  }
}

function publishPlan(
  journal: EventJournal,
  act: string,
  input: {
    idempotencyKey: string;
    taskId: string;
    actorId: string;
    occurredAt: Date;
    priority?: TaskPriority;
    previousPriority?: TaskPriority;
  },
): Promise<EmitResult> {
  const envelope = {
    source: TASK_SOURCE,
    idempotencyKey: input.idempotencyKey,
    actor: { id: input.actorId, role: TASK_ACTOR_ROLE },
    subject: { entity: TASK_SUBJECT, id: input.taskId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  };
  if (act === TASK_TRANSITION_PLAN) {
    return emit(journal, { ...envelope, type: EVENT_TYPES.TASK_PLANNED, payload: { task_id: input.taskId } });
  }
  if (act === TASK_TRANSITION_RESUME) {
    return emit(journal, { ...envelope, type: EVENT_TYPES.TASK_RESUMED, payload: { task_id: input.taskId } });
  }
  if (act === TASK_PRIORITY_ACT && input.priority !== undefined && input.previousPriority !== undefined) {
    return emit(journal, {
      ...envelope,
      type: EVENT_TYPES.TASK_PRIORITIZED,
      payload: { task_id: input.taskId, priority: input.priority, previous_priority: input.previousPriority },
    });
  }
  throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
}

function absentTask(): DomainError {
  return new DomainError(DOMAIN_ERROR.TASK_PLAN_ABSENT, 'задачи с этим номером в топике нет');
}

/**
 * «В план» переносит задачу в `PLANNED` на том же канвасе.
 * «В работу» возвращает её в «Задачи». Слово приоритета крутит `normal` → `high` → `low` → `normal`.
 * Нажимает только исполнитель. Повтор того же callback второго события не пишет.
 * Событие GitHub сюда не входит и статус не меняет.
 */
export async function pressTaskPlan(
  store: TaskPlanStore,
  journal: EventJournal,
  clock: Clock,
  input: TaskPlanPress,
): Promise<TaskPlanResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  if (input.act !== TASK_TRANSITION_PLAN && input.act !== TASK_TRANSITION_RESUME && input.act !== TASK_PRIORITY_ACT) {
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
    throw new DomainError(
      DOMAIN_ERROR.TASK_PLAN_ACTOR,
      '«в план», «в работу» и слово приоритета нажимает только исполнитель',
    );
  }
  const located = {
    telegramChatId: input.telegramChatId,
    topicId,
    messageId: input.messageId,
    taskNumber: input.taskNumber,
  };
  const task = await taskOfCanvasButton(store, located, absentTask());
  assigneeOnly(sender.id, task.assigneeId);
  const prior = await store.seen(idempotencyKey);
  if (prior !== null) {
    return { task, eventId: prior.eventId, applied: false, closesBlocker: false };
  }
  const now = clock.now();
  if (input.act === TASK_PRIORITY_ACT) {
    if (!prioritySetOnCanvas(task.status)) {
      throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'приоритет ставится на канвасе');
    }
    const priority = nextPriority(task.priority);
    const published = await publishPlan(journal, input.act, {
      idempotencyKey,
      taskId: task.id,
      actorId: sender.id,
      occurredAt: now,
      priority,
      previousPriority: task.priority,
    });
    if (published.status === 'duplicate') {
      const current = await taskOfCanvasButton(store, located, absentTask());
      return { task: current, eventId: published.row.id, applied: false, closesBlocker: false };
    }
    const next = defineUnlinked({ ...task, priority, updatedAt: now.toISOString() });
    const saved = await store.savePriority(next, task.priority);
    if (!saved) {
      throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
    }
    return { task: next, eventId: published.row.id, applied: true, closesBlocker: false };
  }
  const move = transitionTask(task.status, input.act);
  const published = await publishPlan(journal, input.act, {
    idempotencyKey,
    taskId: task.id,
    actorId: sender.id,
    occurredAt: now,
  });
  if (published.status === 'duplicate') {
    const current = await taskOfCanvasButton(store, located, absentTask());
    return { task: current, eventId: published.row.id, applied: false, closesBlocker: false };
  }
  const next = defineUnlinked({ ...task, status: move.to, updatedAt: now.toISOString() });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  return { task: next, eventId: published.row.id, applied: true, closesBlocker: move.closesBlocker };
}
