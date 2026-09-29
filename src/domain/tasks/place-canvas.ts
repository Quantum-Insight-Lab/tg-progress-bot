import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { projectCalendarDate } from '../shared/project-time.ts';
import { defineCanvas, type Canvas } from './canvas.ts';

/** Канвас выставляет система (A-31), не человек. */
export const CANVAS_ACTOR_ID = 'system';

export const CANVAS_ACTOR_ROLE = 'system';

export const CANVAS_SUBJECT = 'Canvas';

export const CANVAS_SOURCE = 'system';

/** Куда уходит канвас: топик супергруппы. */
export const CANVAS_DESTINATION_TOPIC = 'supergroup';

/** Личка канвас не получает. */
export const CANVAS_DESTINATION_PRIVATE = 'private';

const CAUSATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Проект, привязка, топик и канвас сегодняшней даты — или пусто, если строки ещё нет. */
export interface CanvasSlotState {
  timezone: string;
  bound: boolean;
  telegramChatId: string | null;
  topicId: number | null;
  existing: Canvas | null;
}

export type CanvasMove =
  | { kind: 'post'; canvasDate: string; telegramChatId: string; topicId: number }
  | { kind: 'edit'; canvas: Canvas };

export interface PostedCanvas {
  id: string;
  projectId: string;
  assigneeId: string;
  topicId: number;
  messageId: number;
  canvasDate: string;
  occurredAt: Date;
}

export interface EditedCanvas {
  canvas: Canvas;
  causationId: string;
  occurredAt: Date;
  shrunk: boolean;
}

/** Причина `canvas.full` у слота A-31: новых суток, без апдейта Telegram. */
export const CANVAS_FULL_SCHEDULE = 'schedule';

export interface FullCanvas {
  canvasId: string | null;
  projectId: string;
  assigneeId: string;
  canvasDate: string;
  cause: string;
  occurredAt: Date;
}

/** Ключ `canvas.posted`: проект, исполнитель и дата. Повтор не создаёт второе сообщение. */
export function postedCanvasKey(projectId: string, assigneeId: string, canvasDate: string): string {
  return `${projectId}+${assigneeId}+${canvasDate}`;
}

/** Ключ `canvas.edited`: канвас и причина правки. */
export function editedCanvasKey(canvasId: string, causationId: string): string {
  return `${canvasId}+${causationId}`;
}

/**
 * Ключ `canvas.full`: слот и причина.
 * Апдейт — `telegram update_id`. Слот A-31 — `schedule`.
 * Голый `update_id` занят событием того же апдейта.
 */
export function fullCanvasKey(projectId: string, assigneeId: string, canvasDate: string, cause: string): string {
  return `${projectId}+${assigneeId}+${canvasDate}+${cause}`;
}

function topicReady(topicId: number | null): topicId is number {
  return topicId !== null && Number.isInteger(topicId) && topicId > 0;
}

/**
 * A-31. Одно сообщение на проект, исполнителя и дату (INV-23).
 * Дата — сутки проекта (INV-24). Личка канвас не дублирует и меню задач не показывает.
 * Пока группа не привязана, сообщения нет. Нет строки на сегодня — новое. Есть — правка того же `message_id`.
 * Другие сообщения бота в топике этот выбор не стирает. Задачи не снимает.
 */
export function decideCanvasMove(destination: string, slot: CanvasSlotState, now: Date): CanvasMove {
  if (destination === CANVAS_DESTINATION_PRIVATE) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_PRIVATE, 'личка канвас не дублирует и меню задач не показывает');
  }
  if (destination !== CANVAS_DESTINATION_TOPIC) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_PLACE, 'канвас живёт в топике исполнителя');
  }
  const telegramChatId = slot.telegramChatId?.trim() ?? '';
  if (!slot.bound || telegramChatId.length === 0) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_UNBOUND, 'канвас появится после привязки');
  }
  if (!topicReady(slot.topicId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_NO_TOPIC, 'канвас живёт в топике исполнителя');
  }
  const canvasDate = projectCalendarDate(now, slot.timezone);
  const existing = slot.existing;
  if (existing === null || existing.canvasDate !== canvasDate) {
    return { kind: 'post', canvasDate, telegramChatId, topicId: slot.topicId };
  }
  return { kind: 'edit', canvas: existing };
}

export interface CanvasInsert {
  insert(canvas: Canvas): Promise<void>;
}

/**
 * Новое сообщение дня: строка `canvases` и `canvas.posted` одной транзакцией.
 * Повтор ключа откатывает вставку.
 */
export async function recordPostedCanvas(
  store: CanvasInsert,
  journal: EventJournal,
  input: PostedCanvas,
): Promise<Canvas> {
  const canvas = defineCanvas(input);
  await store.insert(canvas);
  const published = await emit(journal, {
    type: EVENT_TYPES.CANVAS_POSTED,
    source: CANVAS_SOURCE,
    idempotencyKey: postedCanvasKey(canvas.projectId, canvas.assigneeId, canvas.canvasDate),
    payload: {
      canvas_id: canvas.id,
      project_id: canvas.projectId,
      assignee_id: canvas.assigneeId,
      canvas_date: canvas.canvasDate,
      message_id: canvas.messageId,
    },
    actor: { id: CANVAS_ACTOR_ID, role: CANVAS_ACTOR_ROLE },
    subject: { entity: CANVAS_SUBJECT, id: canvas.id },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.CANVAS_DUPLICATE, 'canvas.posted уже записан');
  }
  return canvas;
}

/** Правка ссылается на событие-причину. Без него второе `canvas.edited` не отличить от повтора. */
export function requireEditCausation(value: string | null): string {
  const causationId = value?.trim() ?? '';
  if (!CAUSATION_UUID.test(causationId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_CAUSATION, 'правка канваса ссылается на причину');
  }
  return causationId;
}

/**
 * Правка того же сообщения. Строку канваса не заменяет и задачи не снимает.
 * `shrunk` — срезы, блокеры или динамика уже ужаты. Повтор той же причины второго события не пишет.
 */
export async function recordEditedCanvas(journal: EventJournal, input: EditedCanvas): Promise<Canvas> {
  const canvas = defineCanvas(input.canvas);
  const causationId = requireEditCausation(input.causationId);
  const published = await emit(journal, {
    type: EVENT_TYPES.CANVAS_EDITED,
    source: CANVAS_SOURCE,
    idempotencyKey: editedCanvasKey(canvas.id, causationId),
    payload: {
      canvas_id: canvas.id,
      shrunk: input.shrunk,
    },
    actor: { id: CANVAS_ACTOR_ID, role: CANVAS_ACTOR_ROLE },
    subject: { entity: CANVAS_SUBJECT, id: canvas.id },
    occurredAt: input.occurredAt,
    causationId,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.CANVAS_DUPLICATE, 'canvas.edited уже записан');
  }
  return canvas;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function filled(value: string): string {
  const trimmed = value.trim();
  return trimmed;
}

/**
 * Отказ: канвас заполнен. Строку `canvases` не создаёт и сообщение не шлёт.
 * `canvas_id` пуст, пока сообщения нет. Повтор той же причины второго события не пишет.
 */
export async function recordFullCanvas(journal: EventJournal, input: FullCanvas): Promise<'applied' | 'duplicate'> {
  const projectId = filled(input.projectId);
  const assigneeId = filled(input.assigneeId);
  const canvasDate = filled(input.canvasDate);
  const cause = filled(input.cause);
  if (projectId.length === 0) throw new DomainError(DOMAIN_ERROR.CANVAS_PROJECT_BLANK, 'У канваса есть проект');
  if (assigneeId.length === 0) throw new DomainError(DOMAIN_ERROR.CANVAS_ASSIGNEE_BLANK, 'У канваса есть исполнитель');
  if (!CALENDAR_DATE.test(canvasDate)) throw new DomainError(DOMAIN_ERROR.CANVAS_DATE, 'Дата канваса — календарный день');
  if (cause.length === 0) throw new DomainError(DOMAIN_ERROR.CANVAS_FULL_CAUSE, 'отказ канваса ссылается на причину');
  const canvasId = filled(input.canvasId ?? '');
  const subjectId = canvasId.length === 0 ? fullCanvasKey(projectId, assigneeId, canvasDate, cause) : canvasId;
  const published = await emit(journal, {
    type: EVENT_TYPES.CANVAS_FULL,
    source: CANVAS_SOURCE,
    idempotencyKey: fullCanvasKey(projectId, assigneeId, canvasDate, cause),
    payload: {
      canvas_id: canvasId.length === 0 ? null : canvasId,
      project_id: projectId,
      assignee_id: assigneeId,
      canvas_date: canvasDate,
    },
    actor: { id: CANVAS_ACTOR_ID, role: CANVAS_ACTOR_ROLE },
    subject: { entity: CANVAS_SUBJECT, id: subjectId },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'duplicate' ? 'duplicate' : 'applied';
}
