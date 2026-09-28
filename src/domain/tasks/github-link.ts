import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineTask, type Task } from './task.ts';

/**
 * Веса и процента у задачи нет.
 * Эти имена не поля строки и не ключ на зеркало.
 */
export const ABSENT_TASK_MEASURES = ['weight', 'percent', 'percentage', 'task_percent'] as const;

/**
 * Внешнего ключа на зеркало нет.
 * Номер issue, PR, коммита и milestone в задаче не хранится.
 */
export const ABSENT_EXTERNAL_KEYS = [
  'external_key',
  'external_id',
  'github_key',
  'github_issue_id',
  'issue_id',
  'issue_number',
  'pull_request_id',
  'pull_request_number',
  'commit_id',
  'commit_sha',
  'milestone_id',
  'milestone_number',
  'mirror_id',
] as const;

/** Текст команды. Ссылки на GitHub нет, шага выбора issue нет. */
export interface AcceptedTaskText {
  title: string;
  githubLink: null;
  issueStep: null;
}

function listed(key: string, fields: readonly string[]): boolean {
  for (const field of fields) {
    if (field === key) return true;
  }
  return false;
}

/**
 * Номер issue или PR в тексте связью не считается.
 * Функция ничего из строки не достаёт.
 */
export function linkFromTitle(title: string): null {
  void title;
  return null;
}

/** Milestone — факт GitHub. Статусом задачи он не становится. */
export function milestoneAsTaskStatus(title: string): null {
  void title;
  return null;
}

/**
 * Формулировка остаётся названием.
 * Лишние поля — попытка выбрать issue: такого шага нет.
 */
export function acceptedTaskText(text: string, extras?: Readonly<Record<string, unknown>>): AcceptedTaskText {
  if (extras !== undefined) {
    for (const key of Object.keys(extras)) {
      void key;
      throw new DomainError(DOMAIN_ERROR.TASK_ISSUE_STEP, 'Шага «выберите issue» нет');
    }
  }
  const title = text.trim();
  return { title, githubLink: linkFromTitle(title), issueStep: null };
}

/** Строка задачи без веса, процента и внешнего ключа. */
export function defineUnlinked(input: Task): Task {
  const record = input as Task & Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (listed(key, ABSENT_TASK_MEASURES)) {
      throw new DomainError(DOMAIN_ERROR.TASK_MEASURE, 'У задачи нет веса и процента');
    }
    if (listed(key, ABSENT_EXTERNAL_KEYS)) {
      throw new DomainError(DOMAIN_ERROR.TASK_EXTERNAL_KEY, 'Задачи с зеркалом не соединены внешним ключом');
    }
  }
  return defineTask(input);
}

/** Работа, которую не завели задачей, в блок «Задачи» не входит. */
export type TasksBlockItem =
  | { source: 'task'; task: Task }
  | { source: 'github'; fact: 'issue' | 'pull_request' | 'commit' | 'milestone' | 'assignment' };

export function tasksBlock(items: readonly TasksBlockItem[]): Task[] {
  const visible: Task[] = [];
  for (const item of items) {
    if (item.source === 'github') continue;
    visible.push(defineUnlinked(item.task));
  }
  return visible;
}

/**
 * Milestone не двигает задачу и не подменяет её статус.
 * Название milestone в названии задачи связью не становится.
 */
export function taskApartFromMilestone(task: Task, milestone: { title: string }): Task {
  linkFromTitle(milestone.title);
  milestoneAsTaskStatus(milestone.title);
  return defineUnlinked(task);
}
