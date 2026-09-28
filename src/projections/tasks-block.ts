import type { CanvasParagraph } from './canvas-message.ts';

/** Заголовок блока. Пустой список абзац не занимает. */
export const TASKS_BLOCK_HEADING = 'Задачи';

/** Кружок у задачи, которая ещё не на подтверждении. */
export const TASK_OPEN_MARK = '○';

/** Галочка у задачи на подтверждении. */
export const TASK_REVIEW_MARK = '✓';

/** Вместо дня, пока руководитель не ответил. */
export const TASK_REVIEW_PLACE = 'на подтверждении';

const REVIEW = 'REVIEW';

/** Строка задачи для первой строки абзаца. Приоритет сюда не входит. */
export interface TaskFirstLine {
  number: number;
  title: string;
  status: string;
  day: number;
}

/** Пометка дня: «3-й день». */
export function taskDayMark(day: number): string {
  return `${String(day)}-й день`;
}

/**
 * Первая строка абзаца: отметка, номер, название и день.
 * У проверки вместо дня — «на подтверждении». Вторая строка — отдельная issue.
 */
export function taskFirstLine(task: TaskFirstLine): string {
  const review = task.status === REVIEW;
  const mark = review ? TASK_REVIEW_MARK : TASK_OPEN_MARK;
  const tail = review ? TASK_REVIEW_PLACE : taskDayMark(task.day);
  return `${mark} ${String(task.number)} — ${task.title} — ${tail}`;
}

/**
 * Блок «Задачи»: заголовок и по абзацу на задачу.
 * Абзац задачи — только первая строка. Пустой список блок не печатает.
 */
export function tasksBlockParagraphs(tasks: readonly TaskFirstLine[]): CanvasParagraph[] {
  if (tasks.length === 0) return [];
  const paragraphs: CanvasParagraph[] = [{ pieces: [{ kind: 'text', text: TASKS_BLOCK_HEADING }] }];
  for (const task of tasks) {
    paragraphs.push({ pieces: [{ kind: 'text', text: taskFirstLine(task) }] });
  }
  return paragraphs;
}
