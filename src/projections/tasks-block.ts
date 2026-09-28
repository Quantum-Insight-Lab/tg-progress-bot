import type { CanvasParagraph, CanvasPiece } from './canvas-message.ts';

/** Заголовок блока. Пустой список абзац не занимает. */
export const TASKS_BLOCK_HEADING = 'Задачи';

/** Кружок у задачи, которая ещё не на подтверждении. */
export const TASK_OPEN_MARK = '○';

/** Галочка у задачи на подтверждении. */
export const TASK_REVIEW_MARK = '✓';

/** Вместо дня, пока руководитель не ответил. */
export const TASK_REVIEW_PLACE = 'на подтверждении';

const REVIEW = 'REVIEW';

/** Строка задачи в блоке: первая строка абзаца и слово приоритета на второй. */
export interface TaskFirstLine {
  number: number;
  title: string;
  status: string;
  day: number;
  priority: string;
}

/** «в план» — задача ещё не на подтверждении. */
export const TASK_PLAN_LABEL = 'в план';

/** «подтвердить» — задача на подтверждении. */
export const TASK_CONFIRM_LABEL = 'подтвердить';

/** «вернуть» — только у задачи на подтверждении. */
export const TASK_RETURN_LABEL = 'вернуть';

/** «отменить» — последняя кнопка второй строки. */
export const TASK_CANCEL_LABEL = 'отменить';

/** Промежуток между кнопками второй строки, как в макете. */
const TASK_LINE_GAP = ' · ';

const TASK_CANVAS_ACTIONS = {
  plan: TASK_PLAN_LABEL,
  confirm: TASK_CONFIRM_LABEL,
  return: TASK_RETURN_LABEL,
  cancel: TASK_CANCEL_LABEL,
} as const;

type TaskCanvasAction = keyof typeof TASK_CANVAS_ACTIONS;

/** Слово текущего приоритета — кнопка на второй строке. */
export const TASK_PRIORITY_ACTION = 'priority';

/** Кружок или галочка на первой строке. Нажатие ставит или снимает галочку. */
export const TASK_MARK_ACTION = 'mark';

/** «В работу»: возврат из плана. Кнопку рисует блок «План». */
export const TASK_RESUME_ACTION = 'resume';

type TaskCanvasCallback = TaskCanvasAction | typeof TASK_PRIORITY_ACTION | typeof TASK_MARK_ACTION | typeof TASK_RESUME_ACTION;

/** Callback кнопки второй строки: акт разберёт нажатие, здесь только адрес задачи на канвасе. */
export function taskCanvasActionData(action: TaskCanvasCallback, taskNumber: number): string {
  return `task:${action}:${String(taskNumber)}`;
}

/** Пометка дня: «3-й день». */
export function taskDayMark(day: number): string {
  return `${String(day)}-й день`;
}

/**
 * Первая строка абзаца: отметка, номер, название и день.
 * У проверки вместо дня — «на подтверждении». Приоритет на первую строку не попадает.
 */
export function taskFirstLine(task: TaskFirstLine): string {
  const review = task.status === REVIEW;
  const mark = review ? TASK_REVIEW_MARK : TASK_OPEN_MARK;
  const tail = review ? TASK_REVIEW_PLACE : taskDayMark(task.day);
  return `${mark} ${String(task.number)} — ${task.title} — ${tail}`;
}

function taskAction(action: TaskCanvasAction, taskNumber: number): CanvasPiece {
  return { kind: 'action', label: TASK_CANVAS_ACTIONS[action], callbackData: taskCanvasActionData(action, taskNumber) };
}

/**
 * Вторая строка того же абзаца: слово текущего приоритета — кнопка,
 * затем «в план» или «подтвердить», у подтверждения ещё «вернуть», и «отменить».
 * Кнопки — внутри абзаца. Номера issue и PR на строку не попадают.
 */
export function taskSecondLinePieces(task: TaskFirstLine): CanvasPiece[] {
  const review = task.status === REVIEW;
  const pieces: CanvasPiece[] = [
    { kind: 'action', label: task.priority, callbackData: taskCanvasActionData(TASK_PRIORITY_ACTION, task.number) },
    { kind: 'text', text: TASK_LINE_GAP },
  ];
  if (review) {
    pieces.push(taskAction('confirm', task.number));
    pieces.push({ kind: 'text', text: TASK_LINE_GAP });
    pieces.push(taskAction('return', task.number));
  } else {
    pieces.push(taskAction('plan', task.number));
  }
  pieces.push({ kind: 'text', text: TASK_LINE_GAP });
  pieces.push(taskAction('cancel', task.number));
  return pieces;
}

/**
 * Абзац задачи: кружок или галочка — кнопка первой строки, остальное — текст,
 * затем кнопки второй. Отметка рисуется из статуса, не из native checkbox.
 */
export function taskParagraphPieces(task: TaskFirstLine): CanvasPiece[] {
  const review = task.status === REVIEW;
  const mark = review ? TASK_REVIEW_MARK : TASK_OPEN_MARK;
  const line = taskFirstLine(task);
  const rest = line.startsWith(mark) ? line.slice(mark.length) : line;
  return [
    { kind: 'action', label: mark, callbackData: taskCanvasActionData(TASK_MARK_ACTION, task.number) },
    { kind: 'text', text: `${rest}\n` },
    ...taskSecondLinePieces(task),
  ];
}

/**
 * Блок «Задачи»: заголовок и по абзацу на задачу.
 * Пустой список блок не печатает.
 */
export function tasksBlockParagraphs(tasks: readonly TaskFirstLine[]): CanvasParagraph[] {
  if (tasks.length === 0) return [];
  const paragraphs: CanvasParagraph[] = [{ pieces: [{ kind: 'text', text: TASKS_BLOCK_HEADING }] }];
  for (const task of tasks) {
    paragraphs.push({ pieces: taskParagraphPieces(task) });
  }
  return paragraphs;
}
