import type { Api } from 'grammy';
import { reviewReminderText, type ReviewLeadMention } from '../projections/review-reminder.ts';

/** Напоминание руководителям в топик исполнителя. */
export async function sendReviewReminder(
  api: Pick<Api, 'sendMessage'>,
  input: { chatId: string; messageThreadId: number; taskNumber: number; leads: readonly ReviewLeadMention[] },
): Promise<void> {
  await api.sendMessage(input.chatId, reviewReminderText(input.taskNumber, input.leads), {
    message_thread_id: input.messageThreadId,
    parse_mode: 'HTML',
  });
}
