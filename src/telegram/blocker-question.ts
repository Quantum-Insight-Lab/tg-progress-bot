import { InlineKeyboard, type Api } from 'grammy';
import { blockerQuestionText, noBlockerButton } from '../projections/blocker-question.ts';

/** Вопрос о блокере в топик исполнителя: текст и кнопка «нет блокера». */
export async function sendBlockerQuestion(
  api: Pick<Api, 'sendMessage'>,
  input: { chatId: string; messageThreadId: number; taskNumber: number; day: number; projectName: string },
): Promise<number> {
  const button = noBlockerButton(input.taskNumber);
  const keyboard = new InlineKeyboard().text(button.label, button.callbackData);
  const sent = await api.sendMessage(input.chatId, blockerQuestionText(input.taskNumber, input.day, input.projectName), {
    message_thread_id: input.messageThreadId,
    reply_markup: keyboard,
    disable_notification: false,
  });
  return sent.message_id;
}
