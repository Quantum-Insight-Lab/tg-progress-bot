import { DEFAULT_PRIORITY } from '../../config/constants.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { acceptedTaskText, defineUnlinked } from './github-link.ts';
import { TASK_STATUS_IN_PROGRESS, taskPriority } from './status.ts';
import type { Task } from './task.ts';

/** Кто заводит задачу. В событии это роль исполнителя. */
export const TASK_ACTOR_ROLE = 'assignee';

export const TASK_SUBJECT = 'Task';

/** Команда приходит из Telegram. */
export const TASK_SOURCE = 'telegram';

/** Топик исполнителя живёт в супергруппе. */
export const TASK_TOPIC_CHAT = 'supergroup';

/** Исполнитель-участник. */
export const TASK_ASSIGNEE_MEMBER = 'member';

/** Исполнитель-руководитель. */
export const TASK_ASSIGNEE_LEAD = 'lead';

/** Хозяин топика в проекте этой супергруппы. */
export interface TopicOwner {
  projectId: string;
  userId: string;
  role: string;
}

/**
 * Порт задач и топика внутри уже открытой транзакции.
 * Контекст проектов сюда не импортируется: роль приходит строкой.
 */
export interface TaskStore {
  ownersOfTopic(telegramChatId: string, topicId: number): Promise<TopicOwner[]>;
  nextNumber(projectId: string): Promise<number>;
  insert(task: Task): Promise<void>;
}

/** Команда `/task`. `sender` пуст, если аккаунта нет. */
export interface NewTask {
  id: string;
  title: string;
  sender: { id: string } | null;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  idempotencyKey: string;
}

export interface CreatedTask {
  task: Task;
  /** Id `task.created`: им правится канвас того же дня. */
  eventId: string;
}

/** Порт для адаптера Telegram. Часы, id и транзакция — у реализации. */
export interface TaskCreation {
  create(input: TaskDraft): Promise<CreatedTask>;
}

export interface TaskDraft {
  telegramUserId: string;
  chat: string;
  telegramChatId: string;
  topicId: number | null;
  title: string;
  idempotencyKey: string;
}

function assigneeRole(value: string): typeof TASK_ASSIGNEE_MEMBER | typeof TASK_ASSIGNEE_LEAD {
  if (value === TASK_ASSIGNEE_MEMBER || value === TASK_ASSIGNEE_LEAD) return value;
  throw new DomainError(DOMAIN_ERROR.TASK_ASSIGNEE_ROLE, 'исполнителем может быть только member или lead этого проекта');
}

/**
 * Формулировка после `/task` — название как есть.
 * Ссылку, номер issue и PR из текста не достаём: это закон связи с зеркалом.
 */
export function taskFormulation(text: string): string {
  return acceptedTaskText(text).title;
}

/**
 * `/task` в своём топике. Название — формулировка, статус — `IN_PROGRESS`,
 * приоритет — `DEFAULT_PRIORITY`, исполнитель — хозяин топика.
 * Повтор того же ключа не пишет вторую задачу.
 */
export async function createTask(
  store: TaskStore,
  journal: EventJournal,
  clock: Clock,
  input: NewTask,
): Promise<CreatedTask> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const title = acceptedTaskText(input.title).title;
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_TITLE_BLANK, 'формулировка после /task становится названием');
  }
  const sender = input.sender;
  const topicId = input.topicId;
  if (input.chat !== TASK_TOPIC_CHAT || sender === null || topicId === null || !Number.isInteger(topicId) || topicId <= 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'задачу заводят командой /task в своём топике');
  }
  const owners = await store.ownersOfTopic(input.telegramChatId, topicId);
  const own = owners.filter((owner) => owner.userId === sender.id);
  if (own.length === 0) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'задачу заводят командой /task в своём топике');
  }
  if (own.length > 1) {
    throw new DomainError(DOMAIN_ERROR.TASK_AMBIGUOUS, 'топик совпал у нескольких проектов');
  }
  const owner = own[0];
  if (owner === undefined) {
    throw new DomainError(DOMAIN_ERROR.TASK_PLACE, 'задачу заводят командой /task в своём топике');
  }
  assigneeRole(owner.role);
  const now = clock.now();
  const task = defineUnlinked({
    id: input.id,
    projectId: owner.projectId,
    number: await store.nextNumber(owner.projectId),
    title,
    status: TASK_STATUS_IN_PROGRESS,
    priority: taskPriority(DEFAULT_PRIORITY),
    assigneeId: owner.userId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
  });
  await store.insert(task);
  const published = await emit(journal, {
    type: EVENT_TYPES.TASK_CREATED,
    source: TASK_SOURCE,
    idempotencyKey,
    payload: {
      task_id: task.id,
      project_id: task.projectId,
      number: task.number,
      title: task.title,
      assignee_id: task.assigneeId,
      priority: task.priority,
    },
    actor: { id: owner.userId, role: TASK_ACTOR_ROLE },
    subject: { entity: TASK_SUBJECT, id: task.id },
    occurredAt: now,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.TASK_DUPLICATE, 'task.created уже записан');
  }
  return { task, eventId: published.row.id };
}
