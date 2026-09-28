import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_REVIEW,
  type TaskStatus,
} from './status.ts';

/** Поставить галочку: задача входит в `REVIEW`. */
export const TASK_TRANSITION_CHECK = 'check';

/** Снять галочку до подтверждения: задача возвращается в `IN_PROGRESS`. */
export const TASK_TRANSITION_UNCHECK = 'uncheck';

interface TransitionRow {
  act: string;
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * Разрешённые пары. Другой акт — в том числе событие GitHub — статус не меняет.
 * Подтверждение и возврат руководителем сюда не входят.
 */
const TASK_TRANSITIONS: readonly TransitionRow[] = [
  { act: TASK_TRANSITION_CHECK, from: TASK_STATUS_IN_PROGRESS, to: TASK_STATUS_REVIEW },
  { act: TASK_TRANSITION_CHECK, from: TASK_STATUS_BLOCKED, to: TASK_STATUS_REVIEW },
  { act: TASK_TRANSITION_UNCHECK, from: TASK_STATUS_REVIEW, to: TASK_STATUS_IN_PROGRESS },
];

export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  /** Выход из `BLOCKED` закрывает блокер. Строку `blockers` пишет акт блокера. */
  closesBlocker: boolean;
}

/** Единственная функция перехода статуса: таблица разрешённых пар. */
export function transitionTask(from: TaskStatus, act: string): TaskTransition {
  let to: TaskStatus | undefined;
  for (const row of TASK_TRANSITIONS) {
    if (row.act === act && row.from === from) to = row.to;
  }
  if (to === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  return {
    from,
    to,
    closesBlocker: from === TASK_STATUS_BLOCKED && to !== TASK_STATUS_BLOCKED,
  };
}

/** Нажатие кружка: галочка, если её ещё нет, и снятие, если задача уже на подтверждении. */
export function markActFor(status: TaskStatus): typeof TASK_TRANSITION_CHECK | typeof TASK_TRANSITION_UNCHECK {
  if (status === TASK_STATUS_REVIEW) return TASK_TRANSITION_UNCHECK;
  return TASK_TRANSITION_CHECK;
}
