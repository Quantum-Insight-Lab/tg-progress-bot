import type { Api } from 'grammy';
import type { CanvasRichMessage } from '../projections/canvas-message.ts';

/** Куда уходит канвас: чат супергруппы и топик исполнителя. */
export interface CanvasTopic {
  chatId: string;
  messageThreadId: number;
}

/**
 * B-6. Канвас уходит методом `sendRichMessage` в топик (`message_thread_id`).
 * Клавиатуры под сообщением нет: `reply_markup` в вызов не передаётся.
 * Правка уже отправленного сообщения — отдельный акт.
 */
export async function sendCanvasMessage(
  api: Pick<Api, 'sendRichMessage'>,
  topic: CanvasTopic,
  message: CanvasRichMessage,
): Promise<number> {
  const sent = await api.sendRichMessage(topic.chatId, message, {
    message_thread_id: topic.messageThreadId,
  });
  return sent.message_id;
}
