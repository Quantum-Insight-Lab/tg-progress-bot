import type { CanvasParagraph, CanvasPiece } from './canvas-message.ts';
import {
  TASK_CANCEL_LABEL,
  TASK_LINE_GAP,
  TASK_PRIORITY_ACTION,
  TASK_RESUME_ACTION,
  taskCanvasActionData,
  taskDayMark,
  type TaskFirstLine,
} from './tasks-block.ts';

/** Заголовок блока. Пустой список абзац не занимает. */
export const PLAN_BLOCK_HEADING = 'План';

/** «В работу»: возврат из плана в «Задачи». */
export const TASK_RESUME_LABEL = 'в работу';

/**
 * Первая строка абзаца плана: номер, название и день.
 * ◻️ и ✅ нет — у `PLANNED` кнопка отметки не рисуется.
 */
export function planFirstLine(task: TaskFirstLine): string {
  return `${String(task.number)} — ${task.title} — ${taskDayMark(task.day)}`;
}

/**
 * Вторая строка: слово текущего приоритета, «в работу» и «отменить».
 * Кнопки — внутри абзаца. «В план», «подтвердить» и «вернуть» сюда не входят.
 */
export function planSecondLinePieces(task: TaskFirstLine): CanvasPiece[] {
  return [
    {
      kind: 'action',
      label: task.priority,
      callbackData: taskCanvasActionData(TASK_PRIORITY_ACTION, task.number),
    },
    { kind: 'text', text: TASK_LINE_GAP },
    {
      kind: 'action',
      label: TASK_RESUME_LABEL,
      callbackData: taskCanvasActionData(TASK_RESUME_ACTION, task.number),
    },
    { kind: 'text', text: TASK_LINE_GAP },
    {
      kind: 'action',
      label: TASK_CANCEL_LABEL,
      callbackData: taskCanvasActionData('cancel', task.number),
    },
  ];
}

/** Абзац задачи в плане: первая строка текстом, вторая — кнопками. Отметки нет. */
export function planParagraphPieces(task: TaskFirstLine): CanvasPiece[] {
  return [{ kind: 'text', text: `${planFirstLine(task)}\n` }, ...planSecondLinePieces(task)];
}

/**
 * Блок «План»: заголовок и по абзацу на задачу.
 * Пустой список блок не печатает. Порядок абзацев — порядок входа.
 */
export function planBlockParagraphs(tasks: readonly TaskFirstLine[]): CanvasParagraph[] {
  if (tasks.length === 0) return [];
  const paragraphs: CanvasParagraph[] = [{ pieces: [{ kind: 'text', text: PLAN_BLOCK_HEADING }] }];
  for (const task of tasks) {
    paragraphs.push({ pieces: planParagraphPieces(task) });
  }
  return paragraphs;
}
