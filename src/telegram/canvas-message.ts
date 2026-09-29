import type { Api } from 'grammy';
import type { CanvasRichMessage } from '../projections/canvas-message.ts';

/** Куда уходит канвас: чат супергруппы и топик исполнителя. */
export interface CanvasTopic {
  chatId: string;
  messageThreadId: number;
}

function assertNoChecklist(message: CanvasRichMessage): void {
  const raw = JSON.stringify(message);
  if (raw.includes('sendChecklist') || raw.includes('"type":"checklist"')) {
    throw new Error('sendChecklist не используем');
  }
}

/**
 * B-6. Канвас уходит методом `sendRichMessage` в топик (`message_thread_id`).
 * `sendChecklist` не вызывается. Клавиатуры под сообщением нет: `reply_markup` в вызов не передаётся.
 */
export async function sendCanvasMessage(
  api: Pick<Api, 'sendRichMessage'>,
  topic: CanvasTopic,
  message: CanvasRichMessage,
): Promise<number> {
  assertNoChecklist(message);
  const sent = await api.sendRichMessage(topic.chatId, message, {
    message_thread_id: topic.messageThreadId,
  });
  return sent.message_id;
}

/**
 * B-6. Уже выставленный канвас правится на месте: `editMessageText` с `rich_message`.
 * Второе сообщение не создаётся. Клавиатуры под сообщением нет.
 */
export async function editCanvasMessage(
  api: Pick<Api, 'editMessageText'>,
  topic: CanvasTopic,
  messageId: number,
  message: CanvasRichMessage,
): Promise<void> {
  assertNoChecklist(message);
  await api.editMessageText(topic.chatId, messageId, message);
}
