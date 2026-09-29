import { taskDayMark } from './tasks-block.ts';

/** Кнопка под вопросом о блокере. Нажатие разбирает следующий акт. */
export const NO_BLOCKER_LABEL = 'нет блокера';

/** «N не двигается K-й день, что мешает?» */
export function blockerQuestionText(taskNumber: number, day: number): string {
  return `${String(taskNumber)} не двигается ${taskDayMark(day)}, что мешает?`;
}

/** Адрес кнопки «нет блокера» на задаче в топике исполнителя. */
export function noBlockerButton(taskNumber: number): { label: string; callbackData: string } {
  return { label: NO_BLOCKER_LABEL, callbackData: `task:noblock:${String(taskNumber)}` };
}

const QUESTION = /^([1-9]\d*) не двигается ([1-9]\d*)-й день, что мешает\?$/;
const NO_BLOCKER_DATA = /^task:noblock:([1-9]\d*)$/;

/** Вопрос бота о блокере. Чужой текст вопросом не считается. */
export function parseBlockerQuestion(text: string): { taskNumber: number; day: number } | null {
  const match = QUESTION.exec(text.trim());
  if (match === null) return null;
  const taskNumber = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isSafeInteger(taskNumber) || !Number.isSafeInteger(day)) return null;
  return { taskNumber, day };
}

/**
 * Reply на вопрос бота. Сообщение человека и ответ не на этот текст сюда не входят.
 */
export function blockerQuestionReply(input: {
  replyToMessageId: number | null;
  repliedText: string | null;
  fromBot: boolean;
}): { replyToMessageId: number; taskNumber: number } | null {
  if (!input.fromBot || input.replyToMessageId === null || input.repliedText === null) return null;
  if (!Number.isInteger(input.replyToMessageId) || input.replyToMessageId <= 0) return null;
  const parsed = parseBlockerQuestion(input.repliedText);
  if (parsed === null) return null;
  return { replyToMessageId: input.replyToMessageId, taskNumber: parsed.taskNumber };
}

/** Номер задачи из callback «нет блокера». */
export function parseNoBlockerData(data: string): number | null {
  const match = NO_BLOCKER_DATA.exec(data);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const taskNumber = Number(raw);
  if (!Number.isSafeInteger(taskNumber)) return null;
  return taskNumber;
}
