import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { TASK_ASSIGNEE_LEAD } from './create-task.ts';
import {
  TASK_STATUS_BLOCKED,
  TASK_STATUS_CANCELLED,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_PLANNED,
  TASK_STATUS_REVIEW,
  type TaskStatus,
} from './status.ts';

/** Поставить галочку: задача входит в `REVIEW`. */
export const TASK_TRANSITION_CHECK = 'check';

/** Снять галочку до подтверждения: задача возвращается в `IN_PROGRESS`. */
export const TASK_TRANSITION_UNCHECK = 'uncheck';

/** Подтвердить: руководитель переводит `REVIEW` в `DONE`. */
export const TASK_TRANSITION_CONFIRM = 'confirm';

/** Вернуть: руководитель возвращает `REVIEW` в работу. */
export const TASK_TRANSITION_RETURN = 'return';

/** «В план»: задача уходит в `PLANNED` на том же канвасе. */
export const TASK_TRANSITION_PLAN = 'plan';

/** «В работу»: задача возвращается из плана в «Задачи». */
export const TASK_TRANSITION_RESUME = 'resume';

/** «Отменить»: задача переходит в `CANCELLED`, пока она не `DONE`. */
export const TASK_TRANSITION_CANCEL = 'cancel';

/**
 * Кто нажал «подтвердить» или «вернуть».
 * Роль — строка участника этого проекта. Контекст проектов сюда не импортируется.
 */
export interface ReviewDecision {
  role: string;
  actorId: string;
  assigneeId: string;
  leadCount: number;
  openBlocker: boolean;
}

interface TransitionRow {
  act: string;
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * Разрешённые пары. Другой акт — событие GitHub, сигнал расхождения, PR, issue, CI — статус не меняет.
 * Из `DONE` пары нет.
 */
const TASK_TRANSITIONS: readonly TransitionRow[] = [
  { act: TASK_TRANSITION_CHECK, from: TASK_STATUS_IN_PROGRESS, to: TASK_STATUS_REVIEW },
  { act: TASK_TRANSITION_CHECK, from: TASK_STATUS_BLOCKED, to: TASK_STATUS_REVIEW },
  { act: TASK_TRANSITION_UNCHECK, from: TASK_STATUS_REVIEW, to: TASK_STATUS_IN_PROGRESS },
  { act: TASK_TRANSITION_CONFIRM, from: TASK_STATUS_REVIEW, to: TASK_STATUS_DONE },
  { act: TASK_TRANSITION_RETURN, from: TASK_STATUS_REVIEW, to: TASK_STATUS_IN_PROGRESS },
  { act: TASK_TRANSITION_PLAN, from: TASK_STATUS_IN_PROGRESS, to: TASK_STATUS_PLANNED },
  { act: TASK_TRANSITION_PLAN, from: TASK_STATUS_BLOCKED, to: TASK_STATUS_PLANNED },
  { act: TASK_TRANSITION_RESUME, from: TASK_STATUS_PLANNED, to: TASK_STATUS_IN_PROGRESS },
  { act: TASK_TRANSITION_CANCEL, from: TASK_STATUS_PLANNED, to: TASK_STATUS_CANCELLED },
  { act: TASK_TRANSITION_CANCEL, from: TASK_STATUS_IN_PROGRESS, to: TASK_STATUS_CANCELLED },
  { act: TASK_TRANSITION_CANCEL, from: TASK_STATUS_BLOCKED, to: TASK_STATUS_CANCELLED },
  { act: TASK_TRANSITION_CANCEL, from: TASK_STATUS_REVIEW, to: TASK_STATUS_CANCELLED },
];

export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  /** Выход из `BLOCKED` закрывает блокер. Строку `blockers` пишет акт блокера. */
  closesBlocker: boolean;
}

/**
 * Снять задачу можно, пока она не `DONE`.
 * `true` — этот запрет ещё не наступил. Какой переход разрешён, решает таблица.
 */
export function openForDismissal(status: TaskStatus): boolean {
  return status !== TASK_STATUS_DONE;
}

function leadDecision(decision: ReviewDecision | undefined, act: string): ReviewDecision {
  if (
    decision === undefined ||
    decision.role !== TASK_ASSIGNEE_LEAD ||
    decision.leadCount < 1 ||
    decision.actorId.trim().length === 0 ||
    decision.assigneeId.trim().length === 0
  ) {
    const message = act === TASK_TRANSITION_RETURN ? 'вернуть может руководитель' : 'нет права подтверждать';
    throw new DomainError(DOMAIN_ERROR.TASK_CONFIRM_ACTOR, message);
  }
  return decision;
}

/**
 * Единственная функция перехода статуса: таблица разрешённых пар.
 * Путь в `DONE` проверяет роль руководителя здесь, а не в обработчике кнопки.
 */
export function transitionTask(from: TaskStatus, act: string, decision?: ReviewDecision): TaskTransition {
  if (!openForDismissal(from)) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  let to: TaskStatus | undefined;
  for (const row of TASK_TRANSITIONS) {
    if (row.act === act && row.from === from) to = row.to;
  }
  if (to === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_TRANSITION, 'переход статуса не разрешён');
  }
  if (to === TASK_STATUS_DONE) {
    const lead = leadDecision(decision, act);
    if (lead.actorId === lead.assigneeId && lead.leadCount !== 1) {
      throw new DomainError(DOMAIN_ERROR.TASK_CONFIRM_ACTOR, 'нет права подтверждать');
    }
    if (lead.openBlocker) {
      throw new DomainError(DOMAIN_ERROR.TASK_OPEN_BLOCKER, 'DONE только без открытого блокера');
    }
  } else if (act === TASK_TRANSITION_RETURN) {
    leadDecision(decision, act);
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
