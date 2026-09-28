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

/** Промежуток между словом приоритета и кнопками, как в макете. */
const TASK_LINE_GAP = ' · ';

const TASK_CANVAS_ACTIONS = {
  plan: TASK_PLAN_LABEL,
  confirm: TASK_CONFIRM_LABEL,
  return: TASK_RETURN_LABEL,
  cancel: TASK_CANCEL_LABEL,
} as const;

type TaskCanvasAction = keyof typeof TASK_CANVAS_ACTIONS;

/** Callback кнопки второй строки: акт разберёт нажатие, здесь только адрес задачи на канвасе. */
export function taskCanvasActionData(action: TaskCanvasAction, taskNumber: number): string {
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
 * Вторая строка того же абзаца: слово приоритета, затем «в план» или «подтвердить»,
 * у подтверждения ещё «вернуть», и «отменить». Кнопки — внутри абзаца.
 */
export function taskSecondLinePieces(task: TaskFirstLine): CanvasPiece[] {
  const review = task.status === REVIEW;
  const pieces: CanvasPiece[] = [{ kind: 'text', text: `${task.priority}${TASK_LINE_GAP}` }];
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

/** Абзац задачи: первая строка и кнопки второй. */
export function taskParagraphPieces(task: TaskFirstLine): CanvasPiece[] {
  return [{ kind: 'text', text: `${taskFirstLine(task)}\n` }, ...taskSecondLinePieces(task)];
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
