import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { projectClock } from '../shared/project-time.ts';
import { defineDailyCron, defineReportsTopicId } from './chat.ts';
import { LEAD_ROLE, MEMBER_ROLE, type ProjectRole } from './member.ts';

/** Личный отчёт. */
export const REPORT_TARGET_PRIVATE = 'private';

/** Отчёт группы. */
export const REPORT_TARGET_GROUP = 'group';

/** Команда `/report`. */
export const REPORT_TRIGGER_COMMAND = 'command';

/** Слот A-33. */
export const REPORT_TRIGGER_SCHEDULE = 'schedule';

/** Рассылка пишет система. */
export const REPORT_ACTOR_SYSTEM = 'system';

export const REPORT_ROLE_SYSTEM = 'system';

/** Корень в событии команды. */
export const REPORT_ROLE_ROOT = 'root';

export const REPORT_SOURCE_TELEGRAM = 'telegram';

export const REPORT_SOURCE_SYSTEM = 'system';

const CHAT_SUBJECT = 'Chat';

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Кто просит отчёт. Роль пуста, если на проектах этой команды её нет. */
export interface ReportActor {
  id: string;
  isRoot: boolean;
  role: ProjectRole | null;
}

/** Проект, который может попасть в текст. */
export interface ReportProjectRef {
  id: string;
  chatId: string | null;
  timezone: string;
  memberIds: readonly string[];
}

/** Группа, в которую уходит командный отчёт. */
export interface ReportGroup {
  id: string;
  telegramChatId: string;
  timezone: string;
  reportsTopicId: number | null;
}

/** Один кусок текста: проекты одного чата и их сутки. */
export interface ReportSection {
  chatId: string;
  date: string;
  audience: 'dm' | 'team';
  memberId: string | null;
  projectIds: readonly string[];
  periodStart: string;
  periodEnd: string;
}

/** Куда отправить текст и какой факт записать. */
export interface ReportCommand {
  target: typeof REPORT_TARGET_PRIVATE | typeof REPORT_TARGET_GROUP;
  chatId: string;
  subjectId: string;
  telegramChatId: string;
  topicId: number | null;
  periodStart: string;
  periodEnd: string;
  trigger: typeof REPORT_TRIGGER_COMMAND;
  idempotencyKey: string;
  actorId: string;
  actorRole: string;
  source: typeof REPORT_SOURCE_TELEGRAM;
  sections: readonly ReportSection[];
}

/** Группа в ходе планировщика. */
export interface GroupReportSlot {
  chatId: string;
  telegramChatId: string;
  timezone: string;
  dailyTime: string | null;
  reportsTopicId: number | null;
}

/** Отчёт, который A-33 должен отправить в командный топик. */
export interface ScheduledReport {
  chatId: string;
  telegramChatId: string;
  topicId: number;
  date: string;
  periodStart: string;
  periodEnd: string;
  idempotencyKey: string;
  projectIds: readonly string[];
}

export interface ReportWindow {
  date: string;
  periodStart: string;
  periodEnd: string;
}

/** Строка «Сейчас» до печати. Имя нужно командному топику. */
export interface ReportNowFact {
  number: number;
  title: string;
  day: number;
  assigneeId: string;
  assigneeName: string | null;
}

/** Строка «Дальше» до печати. */
export interface ReportNextFact {
  number: number;
  title: string;
  assigneeId: string;
}

/** Счётчики задач периода. Их считает домен прогресса, здесь только перевоз. */
export interface ReportTaskFacts {
  confirmed: number;
  created: number;
  cancelled: number;
  blocked: number;
}

/** Репозиторий блока GitHub. Названия issues сюда не кладутся. */
export interface ReportRepositoryFacts {
  repositoryId: string;
  slug: string;
  ci: 'success' | 'failure' | 'cancelled' | 'other' | null;
  commits: number;
  mergedPullRequests: number;
}

/** Проект внутри уже выбранного куска отчёта. */
export interface ReportProjectFacts {
  id: string;
  name: string;
  chatId: string;
  memberIds: readonly string[];
  tasks: ReportTaskFacts;
  now: readonly ReportNowFact[];
  next: readonly ReportNextFact[];
  reasons: readonly { text: string }[];
  divergence: boolean;
  repository: ReportRepositoryFacts | null;
}

/** Факты одного текста. Проекция печатает их и ничего не пересчитывает. */
export interface ReportDocument {
  chatId: string;
  date: string;
  audience: 'dm' | 'team';
  memberId: string | null;
  projects: readonly ReportProjectFacts[];
}

/** Куда уходит уже собранный текст. */
export interface ReportMessage {
  telegramChatId: string;
  topicId: number | null;
  text: string;
}

export type ReportRenderer = (documents: readonly ReportDocument[]) => string;

export type ReportSender = (message: ReportMessage) => Promise<void>;

/** Команда `/report`. Повтор того же обновления возвращает пусто. */
export interface ReportCommands {
  request(input: { telegramUserId: string; chatType: string; telegramChatId: string; idempotencyKey: string }): Promise<ReportMessage | null>;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function calendarDay(value: string): string {
  const date = value.trim();
  if (!CALENDAR_DAY.test(date)) throw new DomainError(DOMAIN_ERROR.CANVAS_DATE, 'дата отчёта — календарный день');
  return date;
}

function commandKey(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.REPORT_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

function actorRoleOf(actor: ReportActor): string {
  if (actor.isRoot) return REPORT_ROLE_ROOT;
  if (actor.role === LEAD_ROLE) return LEAD_ROLE;
  return MEMBER_ROLE;
}

/** Время `H:MM` или `HH:MM` к `HH:MM`. Пустое и неразборчивое временем не считается. */
export function reportClockFace(value: string | null): string | null {
  const cron = defineDailyCron(value);
  if (cron === null) return null;
  const pieces = cron.split(':');
  if (pieces.length !== 1 + 1) return null;
  const hourRaw = pieces[0];
  const minuteRaw = pieces[1];
  if (hourRaw === undefined || minuteRaw === undefined) return null;
  if (!/^\d{1,2}$/.test(hourRaw) || !/^\d{1,2}$/.test(minuteRaw)) return null;
  const hour = hourRaw.padStart(1 + 1, '0');
  const minute = minuteRaw.padStart(1 + 1, '0');
  if (hour < '00' || hour > '23') return null;
  if (minute < '00' || minute > '59') return null;
  return `${hour}:${minute}`;
}

/**
 * Сутки отчёта в уже посчитанном окне.
 * Начало суток собирает инфраструктура: в домене нет `new Date`.
 */
export type ReportWindows = (timezone: string) => ReportWindow;

/**
 * Час отчёта наступил в таймзоне группы.
 * Раньше названного времени — ещё нет. Позже в те же сутки — да: пропуск хода догоняется.
 * Таймзона проекта этот час не задаёт.
 */
export function reportHourReached(now: Date, timezone: string, dailyTime: string | null): boolean {
  const face = reportClockFace(dailyTime);
  if (face === null) return false;
  const local = projectClock(now, timezone);
  return local.time >= face;
}

/** Ключ рассылки: чат и календарный день группы. Повтор в те же сутки второй факт не пишет. */
export function scheduledReportKey(chatId: string, date: string): string {
  const id = chatId.trim();
  if (id.length === 0) throw new DomainError(DOMAIN_ERROR.CHAT_ID_BLANK, 'У группы есть id');
  return `${EVENT_TYPES.REPORT_SENT}+${id}+${calendarDay(date)}`;
}

function memberOf(project: ReportProjectRef, userId: string): boolean {
  return project.memberIds.some((id) => id === userId);
}

function sectionOf(
  chatId: string,
  audience: ReportSection['audience'],
  memberId: string | null,
  projectIds: readonly string[],
  timezone: string,
  windows: ReportWindows,
): ReportSection {
  const window = windows(timezone);
  return {
    chatId,
    date: window.date,
    audience,
    memberId,
    projectIds,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
  };
}

/**
 * Личный `/report`.
 * Рассылка группы на него не влияет: команда отвечает и когда время стёрто.
 * В текст входят проекты этого человека. Чужие проекты сюда не попадают.
 */
export function privateReportCommand(input: {
  actor: ReportActor | null;
  telegramUserId: string;
  projects: readonly ReportProjectRef[];
  chatTimezones: ReadonlyMap<string, string>;
  idempotencyKey: string;
  windows: ReportWindows;
}): ReportCommand {
  const actor = input.actor;
  if (actor === null || blank(actor.id)) throw new DomainError(DOMAIN_ERROR.REPORT_ACCESS, 'нет доступа');
  if (!actor.isRoot && actor.role === null) throw new DomainError(DOMAIN_ERROR.REPORT_ACCESS, 'нет доступа');
  const idempotencyKey = commandKey(input.idempotencyKey);
  const telegramUserId = input.telegramUserId.trim();
  if (telegramUserId.length === 0) throw new DomainError(DOMAIN_ERROR.TELEGRAM_USER_ID, 'telegram_user_id');
  const own = input.projects.filter((project) => memberOf(project, actor.id));
  const byChat = new Map<string, ReportProjectRef[]>();
  for (const project of own) {
    const chatId = project.chatId === null || project.chatId.trim().length === 0 ? `unbound:${project.id}` : project.chatId;
    const list = byChat.get(chatId);
    if (list === undefined) byChat.set(chatId, [project]);
    else list.push(project);
  }
  const sections: ReportSection[] = [];
  for (const [chatId, projects] of byChat) {
    const first = projects[0];
    if (first === undefined) continue;
    const timezone = input.chatTimezones.get(chatId) ?? first.timezone;
    sections.push(
      sectionOf(
        chatId,
        'dm',
        actor.id,
        projects.map((project) => project.id),
        timezone,
        input.windows,
      ),
    );
  }
  sections.sort((left, right) => (left.chatId < right.chatId ? -1 : left.chatId > right.chatId ? 1 : 0));
  const head = sections[0];
  const window = head === undefined ? input.windows('UTC') : { date: head.date, periodStart: head.periodStart, periodEnd: head.periodEnd };
  if (sections.length === 0) {
    sections.push(sectionOf(telegramUserId, 'dm', actor.id, [], 'UTC', input.windows));
  }
  return {
    target: REPORT_TARGET_PRIVATE,
    chatId: telegramUserId,
    subjectId: telegramUserId,
    telegramChatId: telegramUserId,
    topicId: null,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    trigger: REPORT_TRIGGER_COMMAND,
    idempotencyKey,
    actorId: actor.id,
    actorRole: actorRoleOf(actor),
    source: REPORT_SOURCE_TELEGRAM,
    sections,
  };
}

/**
 * `/report` из группы.
 * Командный топик, если он задан, — единственный адрес. Топик исполнителя им не становится.
 * Пока топика нет, ответ уходит в тот же чат, без номера топика.
 * Выключенная рассылка команду не глушит.
 */
export function groupReportCommand(input: {
  actor: ReportActor | null;
  participates: boolean;
  group: ReportGroup | null;
  projects: readonly ReportProjectRef[];
  idempotencyKey: string;
  windows: ReportWindows;
}): ReportCommand {
  const actor = input.actor;
  if (actor === null || blank(actor.id)) throw new DomainError(DOMAIN_ERROR.REPORT_ACCESS, 'нет доступа');
  const group = input.group;
  if (group === null) throw new DomainError(DOMAIN_ERROR.REPORT_UNBOUND, 'пока супергруппа не привязана, отчёта группы нет');
  if (!actor.isRoot && !input.participates) throw new DomainError(DOMAIN_ERROR.REPORT_ACCESS, 'нет доступа');
  const idempotencyKey = commandKey(input.idempotencyKey);
  const topicId = defineReportsTopicId(group.reportsTopicId);
  const projectIds = input.projects.filter((project) => project.chatId === group.id).map((project) => project.id);
  const section = sectionOf(group.id, 'team', null, projectIds, group.timezone, input.windows);
  return {
    target: REPORT_TARGET_GROUP,
    chatId: group.id,
    subjectId: group.id,
    telegramChatId: group.telegramChatId.trim(),
    topicId,
    periodStart: section.periodStart,
    periodEnd: section.periodEnd,
    trigger: REPORT_TRIGGER_COMMAND,
    idempotencyKey,
    actorId: actor.id,
    actorRole: actorRoleOf(actor),
    source: REPORT_SOURCE_TELEGRAM,
    sections: [section],
  };
}

/**
 * A-33. Рассылка только группе, у которой задано время и есть командный топик.
 * Час считается в таймзоне группы. Уже отправленный за эти сутки повторно не ставится.
 */
export function scheduledReport(
  slot: GroupReportSlot,
  projectIds: readonly string[],
  now: Date,
  sent: ReadonlySet<string>,
  windows: ReportWindows,
): ScheduledReport | null {
  const topicId = defineReportsTopicId(slot.reportsTopicId);
  if (topicId === null) return null;
  if (!reportHourReached(now, slot.timezone, slot.dailyTime)) return null;
  const window = windows(slot.timezone);
  const idempotencyKey = scheduledReportKey(slot.chatId, window.date);
  if (sent.has(idempotencyKey)) return null;
  return {
    chatId: slot.chatId.trim(),
    telegramChatId: slot.telegramChatId.trim(),
    topicId,
    date: window.date,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    idempotencyKey,
    projectIds,
  };
}

export interface ReportFact {
  target: typeof REPORT_TARGET_PRIVATE | typeof REPORT_TARGET_GROUP;
  chatId: string;
  subjectId: string;
  topicId: number | null;
  periodStart: string;
  periodEnd: string;
  trigger: typeof REPORT_TRIGGER_COMMAND | typeof REPORT_TRIGGER_SCHEDULE;
  idempotencyKey: string;
  actorId: string;
  actorRole: string;
  source: string;
}

/** Записать `report.sent`. Повтор ключа вторую строку не создаёт. */
export async function publishReportSent(
  journal: EventJournal,
  occurredAt: Date,
  fact: ReportFact,
): Promise<{ applied: boolean; eventId: string }> {
  const published = await emit(journal, {
    type: EVENT_TYPES.REPORT_SENT,
    source: fact.source,
    idempotencyKey: fact.idempotencyKey,
    payload: {
      target: fact.target,
      chat_id: fact.chatId,
      topic_id: fact.topicId,
      period_start: fact.periodStart,
      period_end: fact.periodEnd,
      trigger: fact.trigger,
    },
    actor: { id: fact.actorId, role: fact.actorRole },
    subject: { entity: CHAT_SUBJECT, id: fact.subjectId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return { applied: published.status === 'applied', eventId: published.row.id };
}
