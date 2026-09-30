/**
 * Обработчики, которые стоят за единственным guard. Имя попадает в строку исхода обновления.
 * Новый обработчик добавляется сюда и подключается в процессе после guard.
 */
export const GUARDED_HANDLERS = [
  'start',
  'new-project',
  'chat-binding',
  'participants',
  'executor-topic',
  'github-login',
  'reports-topic',
  'schedule',
  'settings',
  'installation-repositories',
  'project-repository',
  'task',
  'task-mark',
  'task-plan',
  'task-review',
  'task-cancel',
  'blocker-answer',
  'report',
  'rebuild',
] as const;

export type GuardedHandler = (typeof GUARDED_HANDLERS)[number];
