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
