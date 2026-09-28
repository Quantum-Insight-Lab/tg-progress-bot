import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { taskPriority, taskStatus, type TaskPriority, type TaskStatus } from './status.ts';

/**
 * Задача — шаг, который человек ведёт в Telegram.
 * Поля строки: номер внутри проекта, название, проект, приоритет, исполнитель, статус, даты.
 * Ключ — id. Статус и приоритет — из закрытого перечня.
 */
export interface Task {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
  /** Пусто, пока задача не завершена. */
  completedAt: string | null;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/** Поля задачи. Статус и приоритет сверяются с перечнем. */
export function defineTask(input: {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}): Task {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.TASK_ID_BLANK, 'У задачи есть id');
  }
  if (blank(input.projectId)) {
    throw new DomainError(DOMAIN_ERROR.TASK_PROJECT_BLANK, 'У задачи есть проект');
  }
  if (!Number.isInteger(input.number)) {
    throw new DomainError(DOMAIN_ERROR.TASK_NUMBER, 'Номер задачи — целое число внутри проекта');
  }
  if (blank(input.title)) {
    throw new DomainError(DOMAIN_ERROR.TASK_TITLE_BLANK, 'У задачи есть название');
  }
  if (blank(input.status)) {
    throw new DomainError(DOMAIN_ERROR.TASK_STATUS_BLANK, 'У задачи есть статус');
  }
  if (blank(input.priority)) {
    throw new DomainError(DOMAIN_ERROR.TASK_PRIORITY_BLANK, 'У задачи есть приоритет');
  }
  const status = taskStatus(input.status);
  const priority = taskPriority(input.priority);
  if (blank(input.assigneeId)) {
    throw new DomainError(DOMAIN_ERROR.TASK_ASSIGNEE_BLANK, 'У задачи есть исполнитель');
  }
  if (blank(input.createdAt)) {
    throw new DomainError(DOMAIN_ERROR.TASK_CREATED_AT_BLANK, 'У задачи есть дата создания');
  }
  if (blank(input.updatedAt)) {
    throw new DomainError(DOMAIN_ERROR.TASK_UPDATED_AT_BLANK, 'У задачи есть дата изменения');
  }
  if (input.completedAt !== null && blank(input.completedAt)) {
    throw new DomainError(DOMAIN_ERROR.TASK_COMPLETED_AT_BLANK, 'Дата завершения либо пуста, либо задана');
  }
  return {
    id: input.id,
    projectId: input.projectId,
    number: input.number,
    title: input.title,
    status,
    priority,
    assigneeId: input.assigneeId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt,
  };
}
