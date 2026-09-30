import { GITHUB_RATE_FLOOR, MIRROR_LAG_INTERVALS } from '../../config/constants.ts';
import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from './clock.ts';
import { DOMAIN_ERROR, DomainError, type DomainErrorCode } from './errors.ts';

export type CommandRejectionReason = 'no_right' | 'forbidden_transition';

const NO_RIGHT: ReadonlySet<DomainErrorCode> = new Set([
  DOMAIN_ERROR.TASK_ASSIGNEE_ROLE,
  DOMAIN_ERROR.TASK_MARK_ACTOR,
  DOMAIN_ERROR.TASK_CONFIRM_ACTOR,
  DOMAIN_ERROR.TASK_PLAN_ACTOR,
  DOMAIN_ERROR.TASK_CANCEL_ACTOR,
  DOMAIN_ERROR.BLOCKER_ACTOR,
  DOMAIN_ERROR.SETTINGS_ACTOR,
  DOMAIN_ERROR.SETTINGS_ACCESS,
  DOMAIN_ERROR.SCHEDULE_ACTOR,
  DOMAIN_ERROR.SCHEDULE_ACCESS,
  DOMAIN_ERROR.SCHEDULE_ROOT,
  DOMAIN_ERROR.MEMBER_ACTOR,
  DOMAIN_ERROR.MEMBER_ACCESS,
  DOMAIN_ERROR.TOPIC_ACTOR,
  DOMAIN_ERROR.TOPIC_ACCESS,
  DOMAIN_ERROR.REPORTS_TOPIC_ACTOR,
  DOMAIN_ERROR.REPORTS_TOPIC_ROOT,
  DOMAIN_ERROR.REPORTS_TOPIC_ACCESS,
  DOMAIN_ERROR.GITHUB_LOGIN_ACTOR,
  DOMAIN_ERROR.PROJECT_REPOSITORY_ACTOR,
  DOMAIN_ERROR.PROJECT_REPOSITORY_ACCESS,
  DOMAIN_ERROR.PROJECT_REPOSITORY_CHANGE_ACTOR,
  DOMAIN_ERROR.CHAT_BIND_ACTOR,
  DOMAIN_ERROR.REPORT_ACCESS,
  DOMAIN_ERROR.REBUILD_ROOT,
]);

const FORBIDDEN_TRANSITION: ReadonlySet<DomainErrorCode> = new Set([
  DOMAIN_ERROR.TASK_TRANSITION,
  DOMAIN_ERROR.TASK_OPEN_BLOCKER,
]);

/** M-12: нет права или запрещённый переход. Чужой и заполненный канвас сюда не входят. */
export function commandRejectionReason(code: DomainErrorCode): CommandRejectionReason | null {
  if (NO_RIGHT.has(code)) return 'no_right';
  if (FORBIDDEN_TRANSITION.has(code)) return 'forbidden_transition';
  return null;
}

export interface CommandRejection {
  code: DomainErrorCode;
  idempotencyKey: string;
  telegramUserId: string;
}

/** A-38. Повтор того же обновления второй отказ не пишет. Код вне M-12 событие не создаёт. */
export async function recordCommandRejection(journal: EventJournal, clock: Clock, input: CommandRejection): Promise<boolean> {
  const reason = commandRejectionReason(input.code);
  const idempotencyKey = input.idempotencyKey.trim();
  const telegramUserId = input.telegramUserId.trim();
  if (reason === null || idempotencyKey.length === 0 || telegramUserId.length === 0) return false;
  const published = await emit(journal, {
    type: EVENT_TYPES.COMMAND_REJECTED,
    source: 'telegram',
    idempotencyKey,
    payload: { reason, code: input.code },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'User', id: telegramUserId },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}

/** M-17: остаток ниже пола из карточки C-12. */
export function rateBelowFloor(remainingPercent: number): boolean {
  return remainingPercent < GITHUB_RATE_FLOOR;
}

/** M-8: возраст факта больше, чем C-13 интервалов сверки. */
export function mirrorIsStale(elapsedMs: number, intervalMs: number): boolean {
  return elapsedMs > intervalMs * MIRROR_LAG_INTERVALS;
}

/** M-18: закрытые сутки без своего события. Сбой доставки пропуском не считается. */
export function closedDayMissed(input: { dayClosed: boolean; recorded: boolean; failed: boolean }): boolean {
  if (!input.dayClosed) return false;
  if (input.failed) return false;
  return !input.recorded;
}

/** M-10: недельная сводка, когда хотя бы один канвас без доли. Пустой список сводку не шлёт. */
export function noDataShareWarrantsAlert(canvases: number, withoutData: number): boolean {
  if (canvases < 1) return false;
  return withoutData > 0;
}

export function alertIdempotencyKey(metric: string, subjectId: string, periodStart: string): string {
  return `${EVENT_TYPES.ALERT_SENT}+${metric}+${subjectId}+${periodStart}`;
}

export type AlertPeriod = 'day' | 'week';

export interface AlertFact {
  metric: string;
  /** За чем следим: репозиторий, задача, чат. Входит в ключ. */
  subjectId: string;
  /** Корень, которому уходит сообщение. */
  recipientId: string;
  period: AlertPeriod;
  periodStart: string;
  text: string;
}

/** A-45. Повтор ключа второе оповещение не пишет. */
export async function recordAlert(journal: EventJournal, occurredAt: Date, input: AlertFact): Promise<boolean> {
  const metric = input.metric.trim();
  const subjectId = input.subjectId.trim();
  const recipientId = input.recipientId.trim();
  const periodStart = input.periodStart.trim();
  if (metric.length === 0 || subjectId.length === 0 || recipientId.length === 0 || periodStart.length === 0) {
    throw new DomainError(DOMAIN_ERROR.ACCESS_IDEMPOTENCY_KEY, 'ключ оповещения пуст');
  }
  const published = await emit(journal, {
    type: EVENT_TYPES.ALERT_SENT,
    source: 'system',
    idempotencyKey: alertIdempotencyKey(metric, subjectId, periodStart),
    payload: { metric, subject_id: subjectId, period: input.period },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'User', id: recipientId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}

export type MissedSlot = 'A-32' | 'A-33';

export function schedulerMissKey(action: MissedSlot, subjectId: string, date: string): string {
  return `${EVENT_TYPES.SCHEDULER_MISSED}+${action}+${subjectId}+${date}`;
}

/** A-42. */
export async function recordSchedulerMiss(
  journal: EventJournal,
  occurredAt: Date,
  input: { action: MissedSlot; subjectId: string; date: string },
): Promise<boolean> {
  const published = await emit(journal, {
    type: EVENT_TYPES.SCHEDULER_MISSED,
    source: 'system',
    idempotencyKey: schedulerMissKey(input.action, input.subjectId, input.date),
    payload: { action: input.action, subject_id: input.subjectId, date: input.date },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'Event', id: input.subjectId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}

export function invariantViolationKey(invariantId: string, subjectId: string, date: string): string {
  return `${EVENT_TYPES.INVARIANT_VIOLATED}+${invariantId}+${subjectId}+${date}`;
}

/** A-44. Проверка состояние не меняет. */
export async function recordInvariantViolation(
  journal: EventJournal,
  occurredAt: Date,
  input: { invariantId: string; subjectEntity: string; subjectId: string; date: string },
): Promise<boolean> {
  const published = await emit(journal, {
    type: EVENT_TYPES.INVARIANT_VIOLATED,
    source: 'system',
    idempotencyKey: invariantViolationKey(input.invariantId, input.subjectId, input.date),
    payload: {
      invariant_id: input.invariantId,
      subject_entity: input.subjectEntity,
      subject_id: input.subjectId,
      date: input.date,
    },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'Event', id: input.subjectId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}

export type ReportDeliveryTarget = 'private' | 'group';

export function reportDeliveryFailedKey(chatId: string, date: string, target: ReportDeliveryTarget): string {
  return `${EVENT_TYPES.REPORT_DELIVERY_FAILED}+${chatId}+${date}+${target}`;
}

/** A-43. */
export async function recordReportDeliveryFailure(
  journal: EventJournal,
  occurredAt: Date,
  input: { target: ReportDeliveryTarget; chatId: string; topicId: number | null; errorCode: number | null; date: string },
): Promise<boolean> {
  const published = await emit(journal, {
    type: EVENT_TYPES.REPORT_DELIVERY_FAILED,
    source: 'system',
    idempotencyKey: reportDeliveryFailedKey(input.chatId, input.date, input.target),
    payload: {
      target: input.target,
      chat_id: input.chatId,
      topic_id: input.topicId,
      error_code: input.errorCode,
    },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'Chat', id: input.chatId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}

export type TelegramFailureKind = 'edit_rejected' | 'rate_limited' | 'other';

/** M-15. Код 429 отличает адаптер: в домене числа протокола нет. */
export function telegramFailureKind(input: { rateLimited: boolean; edit: boolean }): TelegramFailureKind {
  if (input.rateLimited) return 'rate_limited';
  if (input.edit) return 'edit_rejected';
  return 'other';
}

export function telegramFailureKey(method: string, chatId: string, messageId: string, errorCode: string, scope: string): string {
  return `${EVENT_TYPES.TELEGRAM_API_FAILED}+${method}+${chatId}+${messageId}+${errorCode}+${scope}`;
}

/** A-40. */
export async function recordTelegramFailure(
  journal: EventJournal,
  occurredAt: Date,
  input: {
    method: string;
    kind: TelegramFailureKind;
    errorCode: number;
    chatId: string | null;
    messageId: number | null;
    scope: string;
  },
): Promise<boolean> {
  const chatId = input.chatId ?? '';
  const messageId = input.messageId === null ? '' : String(input.messageId);
  const published = await emit(journal, {
    type: EVENT_TYPES.TELEGRAM_API_FAILED,
    source: 'telegram',
    idempotencyKey: telegramFailureKey(input.method, chatId, messageId, String(input.errorCode), input.scope),
    payload: {
      method: input.method,
      kind: input.kind,
      error_code: input.errorCode,
      chat_id: input.chatId,
      message_id: input.messageId,
    },
    actor: { id: 'system', role: 'system' },
    subject: { entity: 'Chat', id: chatId.length === 0 ? 'telegram' : chatId },
    occurredAt,
    causationId: null,
    correlationId: null,
  });
  return published.status === 'applied';
}
