import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineReportsTopicId } from './chat.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import { LEAD_ROLE, type ProjectRole } from './member.ts';
import type { User } from './user.ts';

/** Имя топика, который бот заводит сам. */
export const REPORTS_TOPIC_NAME = 'Отчёты';

/** Корень в событии. Руководитель проекта — роль `lead`. */
export const REPORTS_TOPIC_ACTOR_ROOT = 'root';

const CHAT_SUBJECT = 'Chat';

/** Проект и супергруппа, на которой живёт командный топик. */
export interface ReportsProject {
  id: string;
  name: string;
  chatId: string | null;
  telegramChatId: string | null;
  reportsTopicId: number | null;
}

export interface ReportsBoard {
  project: { id: string; name: string };
  bound: boolean;
  reportsTopicId: number | null;
}

export interface ReportsHome {
  telegramChatId: string;
  topicId: number;
  created: boolean;
}

/** Порт `chats.reports_topic_id` внутри уже открытой транзакции. */
export interface ReportsTopicStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<ReportsProject[]>;
  findProject(projectId: string): Promise<ReportsProject | null>;
  roleOnProject(projectId: string, userId: string): Promise<ProjectRole | null>;
  executorTopicIds(chatId: string): Promise<number[]>;
  lockChat(chatId: string): Promise<void>;
  setReportsTopic(chatId: string, topicId: number): Promise<void>;
}

export interface ReportsCommand {
  actor: User | null;
  chat: string;
}

export interface ShowReportsTopic extends ReportsCommand {
  projectName: string;
}

export interface ReportsTarget extends ReportsCommand {
  projectId: string;
}

export interface SetReportsTopic extends ReportsTarget {
  topicId: number;
  created: boolean;
  idempotencyKey: string;
}

export interface SetNamedReportsTopic extends ReportsCommand {
  projectName: string;
  topicId: number;
  idempotencyKey: string;
}

/** Порт для адаптера Telegram. Часы и транзакция — у реализации. */
export interface ReportsTopicActions {
  show(input: { telegramUserId: string; projectName: string; chat: string }): Promise<ReportsBoard>;
  prompt(input: { telegramUserId: string; projectId: string; chat: string }): Promise<{ projectName: string }>;
  planCreate(input: {
    telegramUserId: string;
    projectId: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<{ telegramChatId: string; name: string }>;
  assign(input: {
    telegramUserId: string;
    projectId: string;
    topicId: number;
    created: boolean;
    chat: string;
    idempotencyKey: string;
  }): Promise<ReportsHome>;
  specify(input: {
    telegramUserId: string;
    projectName: string;
    topicId: number;
    chat: string;
    idempotencyKey: string;
  }): Promise<ReportsHome>;
}

/**
 * Командный топик и топики исполнителей — разные номера.
 * Совпадение отклоняется с обеих сторон.
 */
export function distinctReportsTopic(topicId: number, occupied: readonly number[]): void {
  for (const other of occupied) {
    if (other === topicId) {
      throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_COLLIDES, 'командный топик не совпадает с топиками исполнителей');
    }
  }
}

async function authorizeView(store: ReportsTopicStore, actor: User | null, chat: string, projectId: string): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_CHAT, 'командный топик указывается в личке');
  }
  if (actor === null) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ACCESS, 'нет доступа');
  if (actor.isRoot) return actor;
  const participates = await store.hasMembership(actor.id);
  if (!participates) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ACCESS, 'нет доступа');
  const role = await store.roleOnProject(projectId, actor.id);
  if (role !== LEAD_ROLE) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ACTOR, 'командный топик указывает руководитель');
  }
  return actor;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

function groupChatId(value: string): string {
  const trimmed = value.trim();
  if (!/^-[1-9]\d*$/.test(trimmed)) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_UNBOUND, 'отчёты живут в топике группы');
  }
  return trimmed;
}

function isBound(project: ReportsProject): boolean {
  return project.chatId !== null && project.telegramChatId !== null;
}

function boundChat(project: ReportsProject): { chatId: string; telegramChatId: string } {
  if (project.chatId === null || project.telegramChatId === null) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_UNBOUND, 'пока супергруппа не привязана, командный топик пуст');
  }
  return { chatId: project.chatId, telegramChatId: groupChatId(project.telegramChatId) };
}

async function oneProject(store: ReportsTopicStore, projectName: string): Promise<ReportsProject> {
  const name = projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0 ? DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_MISSING : DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function requireProject(store: ReportsTopicStore, projectId: string): Promise<ReportsProject> {
  const project = await store.findProject(projectId);
  if (project === null) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function freshProject(store: ReportsTopicStore, project: ReportsProject): Promise<ReportsProject> {
  const bound = boundChat(project);
  await store.lockChat(bound.chatId);
  return requireProject(store, project.id);
}

/** Экран настройки: пока топика нет, бот спрашивает, есть ли он в группе. */
export async function describeReportsTopic(store: ReportsTopicStore, input: ShowReportsTopic): Promise<ReportsBoard> {
  const project = await oneProject(store, input.projectName);
  await authorizeView(store, input.actor, input.chat, project.id);
  return {
    project: { id: project.id, name: project.name },
    bound: isBound(project),
    reportsTopicId: project.reportsTopicId,
  };
}

/** Подсказка, каким сообщением указывают уже существующий топик. */
export async function describeReportsPrompt(store: ReportsTopicStore, input: ReportsTarget): Promise<{ projectName: string }> {
  const project = await requireProject(store, input.projectId);
  const actor = await authorizeView(store, input.actor, input.chat, project.id);
  boundChat(project);
  if (project.reportsTopicId !== null && !actor.isRoot) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ROOT, 'командный топик меняет корень');
  }
  return { projectName: project.name };
}

/**
 * Создавать «Отчёты» можно, пока у группы топика нет.
 * Повтор не заводит второй. Общий топик группы второму проекту не дублируется.
 */
export async function claimNewReportsTopic(
  store: ReportsTopicStore,
  input: ReportsTarget,
): Promise<{ telegramChatId: string; name: string }> {
  const project = await requireProject(store, input.projectId);
  await authorizeView(store, input.actor, input.chat, project.id);
  const fresh = await freshProject(store, project);
  if (fresh.reportsTopicId !== null) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ALREADY, 'командный топик уже есть');
  return { telegramChatId: boundChat(fresh).telegramChatId, name: REPORTS_TOPIC_NAME };
}

/**
 * Записывает командный топик группы и публикует `chat.reports_topic_set`.
 * `created` — бот завёл топик «Отчёты». Иначе номер указал руководитель.
 * Пока топика нет, его ставит корень или руководитель проекта.
 * Дальше номер меняет корень. Повтор ключа откатывает запись.
 */
export async function assignReportsTopic(
  store: ReportsTopicStore,
  journal: EventJournal,
  clock: Clock,
  input: SetReportsTopic,
): Promise<ReportsHome> {
  const project = await requireProject(store, input.projectId);
  const actor = await authorizeView(store, input.actor, input.chat, project.id);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const fresh = await freshProject(store, project);
  if (input.created && fresh.reportsTopicId !== null) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ALREADY, 'командный топик уже есть');
  }
  if (!input.created && fresh.reportsTopicId !== null && !actor.isRoot) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ROOT, 'командный топик меняет корень');
  }
  const topicId = defineReportsTopicId(input.topicId);
  if (topicId === null) throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ID, 'номер командного топика — целое больше нуля');
  const bound = boundChat(fresh);
  distinctReportsTopic(topicId, await store.executorTopicIds(bound.chatId));
  await store.setReportsTopic(bound.chatId, topicId);
  const published = await emit(journal, {
    type: EVENT_TYPES.CHAT_REPORTS_TOPIC_SET,
    source: 'telegram',
    idempotencyKey,
    payload: { chat_id: bound.chatId, topic_id: topicId, created: input.created },
    actor: { id: actor.id, role: actor.isRoot ? REPORTS_TOPIC_ACTOR_ROOT : LEAD_ROLE },
    subject: { entity: CHAT_SUBJECT, id: bound.chatId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_DUPLICATE, 'chat.reports_topic_set уже записан');
  }
  return { telegramChatId: bound.telegramChatId, topicId, created: input.created };
}

/** Корень или руководитель присылает имя проекта и номер уже существующего топика. */
export async function assignNamedReportsTopic(
  store: ReportsTopicStore,
  journal: EventJournal,
  clock: Clock,
  input: SetNamedReportsTopic,
): Promise<ReportsHome> {
  const project = await oneProject(store, input.projectName);
  return assignReportsTopic(store, journal, clock, {
    actor: input.actor,
    chat: input.chat,
    projectId: project.id,
    topicId: input.topicId,
    created: false,
    idempotencyKey: input.idempotencyKey,
  });
}
