import { PROJECT_CREATOR_ROLE } from './create-project.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import type { User } from './user.ts';

/** Супергруппа, в которой живут проекты. Топик исполнителя сюда не записывается. */
export interface Chat {
  id: string;
  telegramChatId: string;
  timezone: string;
  /** Командный топик внутри этой группы. Пусто — не выбран. */
  reportsTopicId: number | null;
  /** Время ежедневной рассылки на чате. Пусто — не задано. */
  dailyCron: string | null;
}

export type ChatKind = 'supergroup' | 'group' | 'channel' | 'private' | 'topic';

/** Что бот увидел в чате, прежде чем руководитель подтвердил привязку. */
export interface SupergroupOffer {
  telegramChatId: string;
  kind: ChatKind;
  forum: boolean;
  canPostMessages: boolean;
  canManageTopics: boolean;
}

/** Куда уходят канвас и отчёты. Пусто, пока группа не привязана. */
export interface OutboundTarget {
  chatId: string;
}

export interface ProjectChat {
  id: string;
  timezone: string;
  chatId: string | null;
}

/** Порт `chats` и `projects.chat_id` внутри уже открытой транзакции. */
export interface ChatStore {
  findProject(projectId: string): Promise<ProjectChat | null>;
  findChatByTelegramId(telegramChatId: string): Promise<Chat | null>;
  insertChat(chat: Chat): Promise<void>;
  setProjectChat(projectId: string, chatId: string): Promise<void>;
}

export interface BindSupergroup {
  projectId: string;
  newChatId: string;
  offer: SupergroupOffer;
  actor: User | null;
  idempotencyKey: string;
}

export interface BoundSupergroup {
  status: 'bound';
  chat: Chat;
  shared: boolean;
}

export interface UnchangedSupergroup {
  status: 'unchanged';
  chat: Chat;
}

export type BindResult = BoundSupergroup | UnchangedSupergroup;

/** Порт для адаптера Telegram. */
export interface ChatBinding {
  unboundProjects(): Promise<{ id: string; name: string }[]>;
  knownChats(): Promise<{ telegramChatId: string }[]>;
  rootTelegramId(): Promise<string | null>;
  confirm(input: {
    telegramUserId: string;
    projectId: string;
    offer: SupergroupOffer;
    idempotencyKey: string;
  }): Promise<BindResult>;
}

/**
 * Канвас и отчёты отправляются только в привязанную группу.
 * Без неё адреса нет.
 */
export function canvasAndReportTarget(chatId: string | null): OutboundTarget | null {
  if (chatId === null || chatId.trim().length === 0) return null;
  return { chatId };
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function supergroupId(value: string): string {
  const trimmed = value.trim();
  if (!/^-[1-9]\d*$/.test(trimmed)) {
    throw new DomainError(DOMAIN_ERROR.CHAT_IS_TOPIC, 'супергруппа, не топик');
  }
  return trimmed;
}

/**
 * Номер командного топика внутри группы.
 * Пусто — топик не выбран. Ноль и дробь топиком не бывают.
 */
export function defineReportsTopicId(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError(DOMAIN_ERROR.REPORTS_TOPIC_ID, 'номер командного топика — целое больше нуля');
  }
  return value;
}

/**
 * Время рассылки на чате.
 * Пустая строка временем не считается: поле остаётся пустым.
 */
export function defineDailyCron(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/** Поля группы при привязке. Командный топик и время ещё не выбраны, топик идентификатором чата не бывает. */
export function defineChat(input: { id: string; telegramChatId: string; timezone: string }): Chat {
  if (blank(input.id)) throw new DomainError(DOMAIN_ERROR.CHAT_ID_BLANK, 'У группы есть id');
  if (blank(input.timezone)) throw new DomainError(DOMAIN_ERROR.CHAT_TIMEZONE_BLANK, 'У группы есть таймзона');
  return {
    id: input.id,
    telegramChatId: supergroupId(input.telegramChatId),
    timezone: input.timezone.trim(),
    reportsTopicId: defineReportsTopicId(null),
    dailyCron: defineDailyCron(null),
  };
}

/** Супергруппа с темами и права администратора, иначе привязка отклоняется. */
export function assessSupergroup(offer: SupergroupOffer): DomainError | null {
  if (offer.kind === 'topic') return new DomainError(DOMAIN_ERROR.CHAT_IS_TOPIC, 'супергруппа, не топик');
  try {
    supergroupId(offer.telegramChatId);
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  if (offer.kind !== 'supergroup' || !offer.forum) {
    return new DomainError(DOMAIN_ERROR.CHAT_NOT_SUPERGROUP, 'нужна супергруппа с темами');
  }
  if (!offer.canPostMessages || !offer.canManageTopics) {
    return new DomainError(DOMAIN_ERROR.CHAT_ADMIN_RIGHTS, 'нужны права на сообщения и управление темами');
  }
  return null;
}

/**
 * Руководитель подтверждает супергруппу.
 * Если она уже привязана к другому проекту, этот садится в ту же группу.
 * Повтор не пишет второй факт.
 * Таймзона новой группы берётся у проекта: отдельная таймзона группы задаётся позже.
 */
export async function bindSupergroup(
  store: ChatStore,
  journal: EventJournal,
  clock: Clock,
  input: BindSupergroup,
): Promise<BindResult> {
  const actor = input.actor;
  if (actor === null || !actor.isRoot) {
    throw new DomainError(DOMAIN_ERROR.CHAT_BIND_ACTOR, 'супергруппу подтверждает руководитель');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.CHAT_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const rejected = assessSupergroup(input.offer);
  if (rejected !== null) throw rejected;
  const project = await store.findProject(input.projectId);
  if (project === null) throw new DomainError(DOMAIN_ERROR.CHAT_PROJECT_MISSING, 'проект не найден');
  const telegramChatId = supergroupId(input.offer.telegramChatId);
  const existing = await store.findChatByTelegramId(telegramChatId);
  if (project.chatId !== null) {
    if (existing !== null && existing.id === project.chatId) return { status: 'unchanged', chat: existing };
    throw new DomainError(DOMAIN_ERROR.CHAT_ALREADY_BOUND, 'у проекта уже есть супергруппа');
  }
  const shared = existing !== null;
  const chat = shared
    ? existing
    : defineChat({ id: input.newChatId, telegramChatId, timezone: project.timezone });
  if (!shared) await store.insertChat(chat);
  await store.setProjectChat(project.id, chat.id);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_CHAT_BOUND,
    source: 'telegram',
    idempotencyKey,
    payload: { project_id: project.id, chat_id: chat.id },
    actor: { id: actor.id, role: PROJECT_CREATOR_ROLE },
    subject: { entity: 'Project', id: project.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.CHAT_DUPLICATE, 'project.chat_bound уже записан');
  }
  return { status: 'bound', chat, shared };
}
