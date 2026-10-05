import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import type { Task } from './task.ts';

/**
 * Поиск задачи кнопки канваса.
 * Сообщение канваса выбирает проект. Без сообщения остаётся поиск по топику:
 * так устроены нажатия, у которых сообщения ещё нет.
 */
export interface CanvasButtonLookup {
  tasksInTopic(telegramChatId: string, topicId: number, taskNumber: number): Promise<Task[]>;
  taskOnCanvas(telegramChatId: string, topicId: number, messageId: number, taskNumber: number): Promise<Task[]>;
}

/** Номер из кнопки, проект — из сообщения канваса, если оно передано. */
export async function taskOfCanvasButton(
  store: CanvasButtonLookup,
  input: {
    telegramChatId: string;
    topicId: number;
    messageId: number | undefined;
    taskNumber: number;
  },
  absent: DomainError,
): Promise<Task> {
  const messageId = input.messageId;
  if (messageId !== undefined && (!Number.isInteger(messageId) || messageId <= 0)) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'кнопка нажимается на канвасе');
  }
  const found =
    messageId === undefined
      ? await store.tasksInTopic(input.telegramChatId, input.topicId, input.taskNumber)
      : await store.taskOnCanvas(input.telegramChatId, input.topicId, messageId, input.taskNumber);
  if (found.length === 0) throw absent;
  if (found.length > 1) {
    throw new DomainError(DOMAIN_ERROR.TASK_AMBIGUOUS, 'топик совпал у нескольких проектов');
  }
  const task = found[0];
  if (task === undefined) throw absent;
  return task;
}
