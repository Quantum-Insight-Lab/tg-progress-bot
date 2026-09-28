import { emit, EVENT_TYPES, type EmitResult, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { TASK_ACTOR_ROLE, TASK_SOURCE, TASK_SUBJECT, TASK_TOPIC_CHAT } from './create-task.ts';
import { defineUnlinked } from './github-link.ts';
import type { TaskStatus } from './status.ts';
import type { Task } from './task.ts';
import { markActFor, TASK_TRANSITION_CHECK, TASK_TRANSITION_UNCHECK, transitionTask } from './transition.ts';

/**
 * Порт галочки внутри уже открытой транзакции.
 * Исполнитель приходит строкой id, контекст проектов сюда не импортируется.
 */
export interface TaskMarkStore {
  sender(telegramUserId: string): Promise<{ id: string } | null>;
  tasksInTopic(telegramChatId: string, topicId: number, taskNumber: number): Promise<Task[]>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

/** Нажатие кружка на канвасе. Ключ — `callback_query_id`. */
export interface TaskMarkPress {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  taskNumber: number;
  idempotencyKey: string;
}

export interface TaskMarkResult {
  task: Task;
  eventId: string;
  /** Повтор того же callback статус не меняет. */
  applied: boolean;
  closesBlocker: boolean;
}

export interface TaskMarking {
  press(input: TaskMarkDraft): Promise<TaskMarkResult>;
}

export interface TaskMarkDraft {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  taskNumber: number;
  idempotencyKey: string;
}

function publishMark(
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
    payload: { task_id: input.taskId },
    actor: { id: input.actorId, role: TASK_ACTOR_ROLE },
    subject: { entity: TASK_SUBJECT, id: input.taskId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  };
  if (act === TASK_TRANSITION_CHECK) {
    return emit(journal, { ...envelope, type: EVENT_TYPES.TASK_CHECKED });
  }
  if (act === TASK_TRANSITION_UNCHECK) {
    return emit(journal, { ...envelope, type: EVENT_TYPES.TASK_UNCHECKED });
  }
  throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
}

/**
 * Кружок ставит галочку и переводит задачу в `REVIEW`.
 * Повтор до подтверждения снимает её и возвращает `IN_PROGRESS`.
 * Ставит и снимает исполнитель. Повтор того же callback второго события не пишет.
 * Причину блокера это нажатие не задаёт.
 */
export async function pressTaskMark(
  store: TaskMarkStore,
  journal: EventJournal,
  clock: Clock,
  input: TaskMarkPress,
): Promise<TaskMarkResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const topicId = input.topicId;
  if (input.chat !== TASK_TOPIC_CHAT || topicId === null || !Number.isInteger(topicId) || topicId <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'галочка нажимается в топике исполнителя');
  }
  if (!Number.isInteger(input.taskNumber) || input.taskNumber <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_NUMBER, 'номер задачи — целое число внутри проекта');
  }
  const sender = await store.sender(input.telegramUserId);
  if (sender === null) {
    throw new DomainError(DOMAIN_ERROR.TASK_MARK_ACTOR, 'галочку ставит исполнитель');
  }
  const found = await store.tasksInTopic(input.telegramChatId, topicId, input.taskNumber);
  if (found.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_MARK_ABSENT, 'задачи с этим номером в топике нет');
  }
  if (found.length > 1) {
    throw new DomainError(DOMAIN_ERROR.TASK_AMBIGUOUS, 'топик совпал у нескольких проектов');
  }
  const task = found[0];
  if (task === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_MARK_ABSENT, 'задачи с этим номером в топике нет');
  }
  if (task.assigneeId !== sender.id) {
    throw new DomainError(DOMAIN_ERROR.TASK_MARK_ACTOR, 'галочку ставит исполнитель');
  }
  const act = markActFor(task.status);
  const move = transitionTask(task.status, act);
  const now = clock.now();
  const published = await publishMark(journal, act, {
    idempotencyKey,
    taskId: task.id,
    actorId: sender.id,
    occurredAt: now,
  });
  if (published.status === 'duplicate') {
    const again = await store.tasksInTopic(input.telegramChatId, topicId, input.taskNumber);
    const current = again.length === 1 ? again[0] : task;
    if (current === undefined) {
      throw new DomainError(DOMAIN_ERROR.TASK_MARK_ABSENT, 'задачи с этим номером в топике нет');
    }
    return { task: current, eventId: published.row.id, applied: false, closesBlocker: false };
  }
  const next = defineUnlinked({
    ...task,
    status: move.to,
    updatedAt: now.toISOString(),
  });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  return { task: next, eventId: published.row.id, applied: true, closesBlocker: move.closesBlocker };
}
