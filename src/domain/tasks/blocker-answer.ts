import { emit, EVENT_TYPES, type EmitResult, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { BLOCKER_SUBJECT } from './detect-blocker.ts';
import { isOpenBlocker, withBlockerReason, type Blocker } from './blocker.ts';
import { TASK_ACTOR_ROLE, TASK_SOURCE, TASK_TOPIC_CHAT } from './create-task.ts';
import { defineUnlinked } from './github-link.ts';
import type { TaskStatus } from './status.ts';
import type { Task } from './task.ts';
import { TASK_TRANSITION_NO_BLOCKER, transitionTask } from './transition.ts';

/**
 * Порт ответа на вопрос о блокере внутри уже открытой транзакции.
 * Исполнитель приходит строкой id.
 */
export interface BlockerAnswerStore {
  sender(telegramUserId: string): Promise<{ id: string } | null>;
  tasksInTopic(telegramChatId: string, topicId: number, taskNumber: number): Promise<Task[]>;
  openBlocker(taskId: string): Promise<Blocker | null>;
  seen(idempotencyKey: string): Promise<{ eventId: string } | null>;
  saveReason(blocker: Blocker): Promise<boolean>;
  saveStatus(task: Task, from: TaskStatus): Promise<boolean>;
}

/** Reply на вопрос бота. Ключ — `update_id`. */
export interface BlockerReasonReply {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  taskNumber: number;
  reason: string;
  replyToMessageId: number | null;
  questionTaskNumber: number | null;
  idempotencyKey: string;
}

export interface BlockerReasonResult {
  task: Task;
  blocker: Blocker;
  eventId: string;
  applied: boolean;
}

/** Нажатие «нет блокера». Ключ — `callback_query_id`. */
export interface NoBlockerPress {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  taskNumber: number;
  idempotencyKey: string;
}

export interface NoBlockerResult {
  task: Task;
  eventId: string;
  applied: boolean;
  closesBlocker: boolean;
}

export interface BlockerAnswering {
  declare(input: BlockerReasonReply): Promise<BlockerReasonResult>;
  dismiss(input: NoBlockerPress): Promise<NoBlockerResult>;
}

/**
 * Причина принимается только как reply на вопрос об этой задаче.
 * Другой текст и сообщение без reply причиной не становятся.
 */
export function questionReplyForTask(input: {
  replyToMessageId: number | null;
  questionTaskNumber: number | null;
  taskNumber: number;
}): { replyToMessageId: number } {
  if (
    input.replyToMessageId === null ||
    !Number.isInteger(input.replyToMessageId) ||
    input.replyToMessageId <= 0 ||
    input.questionTaskNumber !== input.taskNumber
  ) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_REPLY, 'причина — только reply на вопрос бота');
  }
  return { replyToMessageId: input.replyToMessageId };
}

function placeOf(input: { chat: string; topicId: number | null; taskNumber: number; idempotencyKey: string }): {
  topicId: number;
  idempotencyKey: string;
} {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const topicId = input.topicId;
  if (input.chat !== TASK_TOPIC_CHAT || topicId === null || !Number.isInteger(topicId) || topicId <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'ответ на блокер — в топике исполнителя');
  }
  if (!Number.isInteger(input.taskNumber) || input.taskNumber <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_NUMBER, 'номер задачи — целое число внутри проекта');
  }
  return { topicId, idempotencyKey };
}

async function taskInTopic(
  store: BlockerAnswerStore,
  input: { telegramUserId: string; telegramChatId: string; topicId: number; taskNumber: number },
): Promise<{ senderId: string; task: Task }> {
  const sender = await store.sender(input.telegramUserId);
  if (sender === null) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ACTOR, 'на вопрос о блокере отвечает исполнитель');
  }
  const found = await store.tasksInTopic(input.telegramChatId, input.topicId, input.taskNumber);
  if (found.length === 0) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ABSENT, 'задачи с этим номером в топике нет');
  }
  if (found.length > 1) {
    throw new DomainError(DOMAIN_ERROR.TASK_AMBIGUOUS, 'топик совпал у нескольких проектов');
  }
  const task = found[0];
  if (task === undefined) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ABSENT, 'задачи с этим номером в топике нет');
  }
  if (task.assigneeId !== sender.id) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ACTOR, 'на вопрос о блокере отвечает исполнитель');
  }
  return { senderId: sender.id, task };
}

function publishDeclared(
  journal: EventJournal,
  input: { idempotencyKey: string; blockerId: string; reason: string; actorId: string; occurredAt: Date },
): Promise<EmitResult> {
  return emit(journal, {
    type: EVENT_TYPES.BLOCKER_DECLARED,
    source: TASK_SOURCE,
    idempotencyKey: input.idempotencyKey,
    payload: { blocker_id: input.blockerId, reason: input.reason },
    actor: { id: input.actorId, role: TASK_ACTOR_ROLE },
    subject: { entity: BLOCKER_SUBJECT, id: input.blockerId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
}

function publishDismissed(
  journal: EventJournal,
  input: { idempotencyKey: string; blockerId: string; taskId: string; actorId: string; occurredAt: Date },
): Promise<EmitResult> {
  return emit(journal, {
    type: EVENT_TYPES.BLOCKER_DISMISSED,
    source: TASK_SOURCE,
    idempotencyKey: input.idempotencyKey,
    payload: { blocker_id: input.blockerId, task_id: input.taskId },
    actor: { id: input.actorId, role: TASK_ACTOR_ROLE },
    subject: { entity: BLOCKER_SUBJECT, id: input.blockerId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
}

/**
 * Текст reply на вопрос бота становится причиной открытого блокера.
 * Статус задачи не меняется. Повтор того же update второго события не пишет.
 */
export async function declareBlockerReason(
  store: BlockerAnswerStore,
  journal: EventJournal,
  clock: Clock,
  input: BlockerReasonReply,
): Promise<BlockerReasonResult> {
  const place = placeOf(input);
  questionReplyForTask({
    replyToMessageId: input.replyToMessageId,
    questionTaskNumber: input.questionTaskNumber,
    taskNumber: input.taskNumber,
  });
  const { senderId, task } = await taskInTopic(store, {
    telegramUserId: input.telegramUserId,
    telegramChatId: input.telegramChatId,
    topicId: place.topicId,
    taskNumber: input.taskNumber,
  });
  const open = await store.openBlocker(task.id);
  if (open === null || !isOpenBlocker(open)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ABSENT, 'открытого блокера у задачи нет');
  }
  const blocker = withBlockerReason(open, input.reason);
  const reason = blocker.reason;
  if (reason === null) throw new DomainError(DOMAIN_ERROR.BLOCKER_REASON, 'Причина — ответ исполнителя');
  const prior = await store.seen(place.idempotencyKey);
  if (prior !== null) return { task, blocker: open, eventId: prior.eventId, applied: false };
  const now = clock.now();
  const published = await publishDeclared(journal, {
    idempotencyKey: place.idempotencyKey,
    blockerId: blocker.id,
    reason,
    actorId: senderId,
    occurredAt: now,
  });
  if (published.status === 'duplicate') return { task, blocker: open, eventId: published.row.id, applied: false };
  const saved = await store.saveReason(blocker);
  if (!saved) throw new DomainError(DOMAIN_ERROR.BLOCKER_ABSENT, 'открытого блокера у задачи нет');
  return { task, blocker, eventId: published.row.id, applied: true };
}

/**
 * «Нет блокера» возвращает задачу в `IN_PROGRESS` и закрывает блокер.
 * Повтор того же callback второго события не пишет.
 */
export async function pressNoBlocker(
  store: BlockerAnswerStore,
  journal: EventJournal,
  clock: Clock,
  input: NoBlockerPress,
): Promise<NoBlockerResult> {
  const place = placeOf(input);
  const { senderId, task } = await taskInTopic(store, {
    telegramUserId: input.telegramUserId,
    telegramChatId: input.telegramChatId,
    topicId: place.topicId,
    taskNumber: input.taskNumber,
  });
  const prior = await store.seen(place.idempotencyKey);
  if (prior !== null) return { task, eventId: prior.eventId, applied: false, closesBlocker: false };
  const open = await store.openBlocker(task.id);
  if (open === null || !isOpenBlocker(open)) {
    throw new DomainError(DOMAIN_ERROR.BLOCKER_ABSENT, 'открытого блокера у задачи нет');
  }
  const move = transitionTask(task.status, TASK_TRANSITION_NO_BLOCKER);
  const now = clock.now();
  const published = await publishDismissed(journal, {
    idempotencyKey: place.idempotencyKey,
    blockerId: open.id,
    taskId: task.id,
    actorId: senderId,
    occurredAt: now,
  });
  if (published.status === 'duplicate') return { task, eventId: published.row.id, applied: false, closesBlocker: false };
  const next = defineUnlinked({
    ...task,
    status: move.to,
    updatedAt: now.toISOString(),
    completedAt: null,
  });
  const saved = await store.saveStatus(next, move.from);
  if (!saved) throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  return { task: next, eventId: published.row.id, applied: true, closesBlocker: move.closesBlocker };
}
