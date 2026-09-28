import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * Канвас — одно rich-сообщение в топике исполнителя на дату.
 * Свой у каждого исполнителя: пара «проект + исполнитель + дата» — не больше одного сообщения.
 * Ключ — id.
 */
export interface Canvas {
  id: string;
  projectId: string;
  assigneeId: string;
  topicId: number;
  messageId: number;
  canvasDate: string;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function positiveId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Поля канваса. Дата — календарный день, топик и сообщение — положительные номера. */
export function defineCanvas(input: {
  id: string;
  projectId: string;
  assigneeId: string;
  topicId: number;
  messageId: number;
  canvasDate: string;
}): Canvas {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ID_BLANK, 'У канваса есть id');
  }
  if (blank(input.projectId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_PROJECT_BLANK, 'У канваса есть проект');
  }
  if (blank(input.assigneeId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ASSIGNEE_BLANK, 'У канваса есть исполнитель');
  }
  if (!positiveId(input.topicId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_TOPIC_ID, 'Топик канваса — положительный номер');
  }
  if (!positiveId(input.messageId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_MESSAGE_ID, 'Сообщение канваса — положительный номер');
  }
  const canvasDate = input.canvasDate.trim();
  if (!CALENDAR_DATE.test(canvasDate)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_DATE, 'Дата канваса — календарный день');
  }
  return {
    id: input.id,
    projectId: input.projectId,
    assigneeId: input.assigneeId,
    topicId: input.topicId,
    messageId: input.messageId,
    canvasDate,
  };
}

/** Слот сообщения: проект, исполнитель и дата. Второго сообщения в том же слоте нет. */
export function canvasSlot(canvas: Pick<Canvas, 'projectId' | 'assigneeId' | 'canvasDate'>): string {
  return `${canvas.projectId}\n${canvas.assigneeId}\n${canvas.canvasDate}`;
}

/** Одна пара «проект + исполнитель + дата» — одно сообщение, даже если номера сообщений различаются. */
export function sameCanvasMessage(
  left: Pick<Canvas, 'projectId' | 'assigneeId' | 'canvasDate'>,
  right: Pick<Canvas, 'projectId' | 'assigneeId' | 'canvasDate'>,
): boolean {
  return canvasSlot(left) === canvasSlot(right);
}
