import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import type { ProjectRole } from './member.ts';
import { distinctReportsTopic } from './reports-topic.ts';
import type { User } from './user.ts';

/** Кто указывает топик. В событии это роль `root`. */
export const EXECUTOR_TOPIC_ACTOR_ROLE = 'root';

const TOPIC_SUBJECT = 'ProjectMember';

/** Проект и его супергруппа. `telegramChatId` пуст, пока группа не привязана. */
export interface TopicProject {
  id: string;
  name: string;
  chatId: string | null;
  telegramChatId: string | null;
}

/** Участник на экране топика: роль этого проекта и номер топика, если он уже есть. */
export interface TopicMember {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  name: string;
  telegramUserId: string;
  /** Пусто — сопоставления с GitHub нет, строка бэклога в первом сообщении не нужна. */
  githubLogin: string | null;
  topicId: number | null;
}

export interface TopicBoard {
  project: { id: string; name: string };
  bound: boolean;
  members: TopicMember[];
}

/** Куда встанет канвас: топик супергруппы, не личка. */
export interface CanvasHome {
  telegramChatId: string;
  topicId: number;
}

export interface AssignedTopic {
  name: string;
  created: boolean;
  home: CanvasHome;
  projectName: string;
  telegramUserId: string;
  githubLogin: string | null;
}

/** Порт `project_members.topic_id` внутри уже открытой транзакции. */
export interface ExecutorTopicStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<TopicProject[]>;
  findProject(projectId: string): Promise<TopicProject | null>;
  members(projectId: string): Promise<TopicMember[]>;
  findMember(projectId: string, userId: string): Promise<TopicMember | null>;
  findMembersByName(projectId: string, name: string): Promise<TopicMember[]>;
  setTopic(memberId: string, topicId: number): Promise<void>;
  reportsTopicId(projectId: string): Promise<number | null>;
}

export interface TopicCommand {
  actor: User | null;
  chat: string;
}

export interface ShowTopics extends TopicCommand {
  projectName: string;
}

export interface TopicTarget extends TopicCommand {
  projectId: string;
  target: User | null;
}

export interface AssignTopic extends TopicTarget {
  topicId: number;
  created: boolean;
  idempotencyKey: string;
}

export interface AssignNamedTopic extends TopicCommand {
  projectName: string;
  memberName: string;
  topicId: number;
  idempotencyKey: string;
}

/** Порт для адаптера Telegram. Часы и транзакция — у реализации. */
export interface ExecutorTopicActions {
  show(input: { telegramUserId: string; projectName: string; chat: string }): Promise<TopicBoard>;
  prompt(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    chat: string;
  }): Promise<{ projectName: string; memberName: string }>;
  planCreate(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<{ telegramChatId: string; name: string }>;
  assign(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    topicId: number;
    created: boolean;
    chat: string;
    idempotencyKey: string;
  }): Promise<AssignedTopic>;
  specify(input: {
    telegramUserId: string;
    projectName: string;
    memberName: string;
    topicId: number;
    chat: string;
    idempotencyKey: string;
  }): Promise<AssignedTopic>;
}

async function requireRoot(store: ExecutorTopicStore, actor: User | null, chat: string): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.TOPIC_CHAT, 'топик указывается в личке');
  }
  if (actor === null || !actor.isRoot) {
    const member = actor !== null && (await store.hasMembership(actor.id));
    if (!member) throw new DomainError(DOMAIN_ERROR.TOPIC_ACCESS, 'нет доступа');
    throw new DomainError(DOMAIN_ERROR.TOPIC_ACTOR, 'топик указывает корень');
  }
  return actor;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.TOPIC_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

/** Номер топика форума — целое больше нуля. */
export function executorTopicId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError(DOMAIN_ERROR.TOPIC_ID, 'номер топика — целое больше нуля');
  }
  return value;
}

function groupChatId(value: string): string {
  const trimmed = value.trim();
  if (!/^-[1-9]\d*$/.test(trimmed)) {
    throw new DomainError(DOMAIN_ERROR.TOPIC_UNBOUND, 'канвас живёт в топике группы');
  }
  return trimmed;
}

function boundGroup(project: TopicProject): string {
  if (project.chatId === null || project.telegramChatId === null) {
    throw new DomainError(DOMAIN_ERROR.TOPIC_UNBOUND, 'пока супергруппа не привязана, топик исполнителя пуст');
  }
  return groupChatId(project.telegramChatId);
}

function isBound(project: TopicProject): boolean {
  return project.chatId !== null && project.telegramChatId !== null;
}

async function oneProject(store: ExecutorTopicStore, projectName: string): Promise<TopicProject> {
  const name = projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.TOPIC_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0 ? DOMAIN_ERROR.TOPIC_PROJECT_MISSING : DOMAIN_ERROR.TOPIC_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.TOPIC_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function requireProject(store: ExecutorTopicStore, projectId: string): Promise<TopicProject> {
  const project = await store.findProject(projectId);
  if (project === null) throw new DomainError(DOMAIN_ERROR.TOPIC_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function requireMember(store: ExecutorTopicStore, projectId: string, target: User | null): Promise<TopicMember> {
  if (target === null) throw new DomainError(DOMAIN_ERROR.TOPIC_ABSENT, 'в проекте этого человека нет');
  const member = await store.findMember(projectId, target.id);
  if (member === null) throw new DomainError(DOMAIN_ERROR.TOPIC_ABSENT, 'в проекте этого человека нет');
  return member;
}

/**
 * Канвас исполнителя живёт в одном топике супергруппы.
 * Личка этим адресом не становится.
 */
export function canvasHome(telegramChatId: string, topicId: number): CanvasHome {
  return { telegramChatId: groupChatId(telegramChatId), topicId: executorTopicId(topicId) };
}

/** Экран настройки: у кого топик пуст, бот спрашивает, есть ли он в группе. */
export async function describeExecutorTopics(store: ExecutorTopicStore, input: ShowTopics): Promise<TopicBoard> {
  await requireRoot(store, input.actor, input.chat);
  const project = await oneProject(store, input.projectName);
  return {
    project: { id: project.id, name: project.name },
    bound: isBound(project),
    members: await store.members(project.id),
  };
}

/** Подсказка, каким сообщением корень указывает уже существующий топик. */
export async function describeTopicPrompt(store: ExecutorTopicStore, input: TopicTarget): Promise<{ projectName: string; memberName: string }> {
  await requireRoot(store, input.actor, input.chat);
  const project = await requireProject(store, input.projectId);
  boundGroup(project);
  const member = await requireMember(store, project.id, input.target);
  return { projectName: project.name, memberName: member.name };
}

/**
 * Создавать топик можно, только если супергруппа привязана и своего топика ещё нет.
 * Повтор не заводит второй.
 */
export async function claimNewExecutorTopic(
  store: ExecutorTopicStore,
  input: TopicTarget,
): Promise<{ telegramChatId: string; name: string }> {
  await requireRoot(store, input.actor, input.chat);
  const project = await requireProject(store, input.projectId);
  const telegramChatId = boundGroup(project);
  const member = await requireMember(store, project.id, input.target);
  if (member.topicId !== null) throw new DomainError(DOMAIN_ERROR.TOPIC_ALREADY, 'топик уже есть');
  return { telegramChatId, name: member.name };
}

/**
 * Записывает топик исполнителя и публикует `member.topic_set`.
 * `created` — бот завёл топик сам. Иначе номер указал корень.
 * Повтор ключа откатывает запись: второго события нет.
 * И `member`, и `lead` получают топик.
 */
export async function assignExecutorTopic(
  store: ExecutorTopicStore,
  journal: EventJournal,
  clock: Clock,
  input: AssignTopic,
): Promise<AssignedTopic> {
  const actor = await requireRoot(store, input.actor, input.chat);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const project = await requireProject(store, input.projectId);
  const telegramChatId = boundGroup(project);
  const member = await requireMember(store, project.id, input.target);
  if (input.created && member.topicId !== null) throw new DomainError(DOMAIN_ERROR.TOPIC_ALREADY, 'топик уже есть');
  const topicId = executorTopicId(input.topicId);
  const home = canvasHome(telegramChatId, topicId);
  const reportsTopicId = await store.reportsTopicId(project.id);
  if (reportsTopicId !== null) distinctReportsTopic(home.topicId, [reportsTopicId]);
  await store.setTopic(member.id, home.topicId);
  const published = await emit(journal, {
    type: EVENT_TYPES.MEMBER_TOPIC_SET,
    source: 'telegram',
    idempotencyKey,
    payload: {
      project_id: project.id,
      user_id: member.userId,
      topic_id: home.topicId,
      created: input.created,
    },
    actor: { id: actor.id, role: EXECUTOR_TOPIC_ACTOR_ROLE },
    subject: { entity: TOPIC_SUBJECT, id: member.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.TOPIC_DUPLICATE, 'member.topic_set уже записан');
  }
  return {
    name: member.name,
    created: input.created,
    home,
    projectName: project.name,
    telegramUserId: member.telegramUserId,
    githubLogin: member.githubLogin,
  };
}

/** Корень присылает имя человека и номер уже существующего топика. */
export async function assignNamedExecutorTopic(
  store: ExecutorTopicStore,
  journal: EventJournal,
  clock: Clock,
  input: AssignNamedTopic,
): Promise<AssignedTopic> {
  await requireRoot(store, input.actor, input.chat);
  const project = await oneProject(store, input.projectName);
  const memberName = input.memberName.trim();
  if (memberName.length === 0) throw new DomainError(DOMAIN_ERROR.TOPIC_ABSENT, 'в проекте этого человека нет');
  const named = await store.findMembersByName(project.id, memberName);
  if (named.length !== 1) {
    throw new DomainError(
      named.length === 0 ? DOMAIN_ERROR.TOPIC_ABSENT : DOMAIN_ERROR.TOPIC_AMBIGUOUS,
      named.length === 0 ? 'в проекте этого человека нет' : 'имя человека не одно',
    );
  }
  const member = named[0];
  if (member === undefined) throw new DomainError(DOMAIN_ERROR.TOPIC_ABSENT, 'в проекте этого человека нет');
  return assignExecutorTopic(store, journal, clock, {
    actor: input.actor,
    chat: input.chat,
    projectId: project.id,
    target: {
      id: member.userId,
      telegramUserId: member.telegramUserId,
      githubLogin: member.githubLogin,
      name: member.name,
      isRoot: false,
    },
    topicId: input.topicId,
    created: false,
    idempotencyKey: input.idempotencyKey,
  });
}
