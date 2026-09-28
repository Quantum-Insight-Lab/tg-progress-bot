import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineDailyCron } from './chat.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import { LEAD_ROLE, type ProjectRole } from './member.ts';
import type { User } from './user.ts';

/** Корень в событии. Руководитель проекта — роль `lead`. */
export const SCHEDULE_ACTOR_ROOT = 'root';

const CHAT_SUBJECT = 'Chat';

/** Проект и группа, на которой живёт расписание. */
export interface ScheduleProject {
  id: string;
  name: string;
  timezone: string;
  chatId: string | null;
  chatTimezone: string | null;
  dailyCron: string | null;
}

export interface ScheduleBoard {
  project: { id: string; name: string };
  bound: boolean;
  /** Пусто — время не названо, рассылка выключена. */
  dailyTime: string | null;
  /** Таймзона группы. Пусто, пока группа не привязана. */
  timezone: string | null;
  mailing: boolean;
}

export interface ScheduleOutcome {
  board: ScheduleBoard;
  changed: boolean;
}

/**
 * Час отчёта — время и таймзона группы.
 * Пустое время рассылку не включает, даже если таймзона группы уже есть.
 */
export function reportSchedule(chat: { id: string; timezone: string; dailyCron: string | null }): {
  chatId: string;
  dailyTime: string;
  timezone: string;
} | null {
  const dailyTime = defineDailyCron(chat.dailyCron);
  if (dailyTime === null) return null;
  const timezone = chat.timezone.trim();
  if (timezone.length === 0) throw new DomainError(DOMAIN_ERROR.SCHEDULE_TIMEZONE_BLANK, 'у группы есть таймзона');
  return { chatId: chat.id, dailyTime, timezone };
}

/** Рассылка включена, пока на группе задано время. */
export function mailingEnabled(dailyCron: string | null): boolean {
  return defineDailyCron(dailyCron) !== null;
}

/** Порт `chats.daily_cron` и `chats.timezone` внутри уже открытой транзакции. */
export interface ScheduleStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<ScheduleProject[]>;
  roleOnProject(projectId: string, userId: string): Promise<ProjectRole | null>;
  lockChat(chatId: string): Promise<void>;
  readChat(chatId: string): Promise<{ timezone: string; dailyCron: string | null } | null>;
  saveSchedule(chatId: string, dailyTime: string, timezone: string): Promise<void>;
  clearTime(chatId: string): Promise<void>;
}

export interface ScheduleCommand {
  actor: User | null;
  chat: string;
}

export interface ShowSchedule extends ScheduleCommand {
  projectName: string;
}

export interface SetSchedule extends ShowSchedule {
  dailyTime: string;
  timezone: string;
  idempotencyKey: string;
}

export interface ClearSchedule extends ShowSchedule {
  idempotencyKey: string;
}

/** Порт для адаптера Telegram. Часы и транзакция — у реализации. */
export interface ScheduleActions {
  show(input: { telegramUserId: string; projectName: string; chat: string }): Promise<ScheduleBoard>;
  set(input: {
    telegramUserId: string;
    projectName: string;
    dailyTime: string;
    timezone: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<ScheduleOutcome>;
  clear(input: { telegramUserId: string; projectName: string; chat: string; idempotencyKey: string }): Promise<ScheduleOutcome>;
}

async function authorize(store: ScheduleStore, actor: User | null, chat: string, projectId: string): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_CHAT, 'расписание задаётся в личке');
  }
  if (actor === null) throw new DomainError(DOMAIN_ERROR.SCHEDULE_ACCESS, 'нет доступа');
  if (actor.isRoot) return actor;
  const participates = await store.hasMembership(actor.id);
  if (!participates) throw new DomainError(DOMAIN_ERROR.SCHEDULE_ACCESS, 'нет доступа');
  const role = await store.roleOnProject(projectId, actor.id);
  if (role !== LEAD_ROLE) {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_ACTOR, 'время отчёта задаёт руководитель');
  }
  return actor;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.SCHEDULE_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

async function oneProject(store: ScheduleStore, projectName: string): Promise<ScheduleProject> {
  const name = projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.SCHEDULE_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0 ? DOMAIN_ERROR.SCHEDULE_PROJECT_MISSING : DOMAIN_ERROR.SCHEDULE_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.SCHEDULE_PROJECT_MISSING, 'проект не найден');
  return project;
}

function boardOf(project: ScheduleProject, dailyCron: string | null, chatTimezone: string | null): ScheduleBoard {
  const bound = project.chatId !== null && chatTimezone !== null;
  const dailyTime = bound ? defineDailyCron(dailyCron) : null;
  return {
    project: { id: project.id, name: project.name },
    bound,
    dailyTime,
    timezone: bound ? chatTimezone : null,
    mailing: dailyTime !== null,
  };
}

function requireChat(project: ScheduleProject): string {
  if (project.chatId === null || project.chatTimezone === null) {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_UNBOUND, 'пока супергруппа не привязана, расписания нет');
  }
  return project.chatId;
}

/** Экран настройки: пока время не названо, рассылка выключена. */
export async function describeSchedule(store: ScheduleStore, input: ShowSchedule): Promise<ScheduleBoard> {
  const project = await oneProject(store, input.projectName);
  await authorize(store, input.actor, input.chat, project.id);
  return boardOf(project, project.dailyCron, project.chatTimezone);
}

/**
 * Задаёт время отчёта и таймзону группы и публикует `chat.schedule_set`.
 * Пока время пустое, его ставит корень или руководитель проекта.
 * Дальше время и таймзону меняет корень. Повтор ключа откатывает запись.
 * Поле живёт на группе: проекты той же группы своего времени не получают.
 */
export async function setChatSchedule(
  store: ScheduleStore,
  journal: EventJournal,
  clock: Clock,
  input: SetSchedule,
): Promise<ScheduleOutcome> {
  const project = await oneProject(store, input.projectName);
  const actor = await authorize(store, input.actor, input.chat, project.id);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const chatId = requireChat(project);
  const dailyTime = defineDailyCron(input.dailyTime);
  if (dailyTime === null) throw new DomainError(DOMAIN_ERROR.SCHEDULE_TIME_BLANK, 'время отчёта не названо');
  const timezone = input.timezone.trim();
  if (timezone.length === 0) throw new DomainError(DOMAIN_ERROR.SCHEDULE_TIMEZONE_BLANK, 'таймзона группы не названа');
  await store.lockChat(chatId);
  const current = await store.readChat(chatId);
  if (current === null) throw new DomainError(DOMAIN_ERROR.SCHEDULE_UNBOUND, 'пока супергруппа не привязана, расписания нет');
  if (mailingEnabled(current.dailyCron) && !actor.isRoot) {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_ROOT, 'время отчёта меняет корень');
  }
  await store.saveSchedule(chatId, dailyTime, timezone);
  const published = await emit(journal, {
    type: EVENT_TYPES.CHAT_SCHEDULE_SET,
    source: 'telegram',
    idempotencyKey,
    payload: { chat_id: chatId, daily_time: dailyTime, timezone },
    actor: { id: actor.id, role: actor.isRoot ? SCHEDULE_ACTOR_ROOT : LEAD_ROLE },
    subject: { entity: CHAT_SUBJECT, id: chatId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_DUPLICATE, 'chat.schedule_set уже записан');
  }
  return {
    changed: true,
    board: {
      project: { id: project.id, name: project.name },
      bound: true,
      dailyTime,
      timezone,
      mailing: true,
    },
  };
}

/**
 * Выключает рассылку: стирает время группы и публикует `chat.schedule_cleared`.
 * Таймзона группы остаётся. Стирает корень. Повтор ключа откатывает запись.
 * Уже пустое время второго факта не пишет.
 */
export async function clearChatSchedule(
  store: ScheduleStore,
  journal: EventJournal,
  clock: Clock,
  input: ClearSchedule,
): Promise<ScheduleOutcome> {
  const project = await oneProject(store, input.projectName);
  const actor = await authorize(store, input.actor, input.chat, project.id);
  if (!actor.isRoot) throw new DomainError(DOMAIN_ERROR.SCHEDULE_CLEAR, 'рассылку выключает корень');
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const chatId = requireChat(project);
  await store.lockChat(chatId);
  const current = await store.readChat(chatId);
  if (current === null) throw new DomainError(DOMAIN_ERROR.SCHEDULE_UNBOUND, 'пока супергруппа не привязана, расписания нет');
  const board = boardOf(project, null, current.timezone);
  if (!mailingEnabled(current.dailyCron)) return { changed: false, board };
  await store.clearTime(chatId);
  const published = await emit(journal, {
    type: EVENT_TYPES.CHAT_SCHEDULE_CLEARED,
    source: 'telegram',
    idempotencyKey,
    payload: { chat_id: chatId },
    actor: { id: actor.id, role: SCHEDULE_ACTOR_ROOT },
    subject: { entity: CHAT_SUBJECT, id: chatId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.SCHEDULE_DUPLICATE, 'chat.schedule_cleared уже записан');
  }
  return { changed: true, board };
}
