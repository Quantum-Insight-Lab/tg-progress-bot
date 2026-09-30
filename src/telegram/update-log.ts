import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot, Context, Transformer } from 'grammy';
import type { Clock } from '../domain/shared/clock.ts';
import { DomainError, type DomainErrorCode } from '../domain/shared/errors.ts';
import type { LogFields, Logger } from '../domain/shared/logger.ts';
import { telegramFailureKind } from '../domain/shared/observe.ts';
import type { GuardedHandler } from './handlers.ts';

const STEP_UPDATE = 'telegram.update';
const STEP_GUARD = 'telegram.guard';
const STEP_OUTCOME = 'telegram.outcome';
const STEP_API = 'telegram.api';

const RATE_LIMITED = 429;

const COMMAND_NAME = /^\/[A-Za-z0-9_]+$/;

const CALLBACK_KIND_PART = /^[a-z]+$/;

export type GuardDecision = 'allow' | 'deny';

/** `start` и `no_person` guard пропускает без проверки: `/start` делает человека известным, у обновления без человека проверять некого. */
export type GuardBasis = 'start' | 'no_person' | 'gate';

type Outcome = 'replied' | 'silent' | 'unhandled' | 'denied' | 'refused' | 'failed';

interface UpdateTrace {
  logger: Logger;
  updateId: number;
  handler: GuardedHandler | null;
  denied: boolean;
  refusal: DomainErrorCode | null;
  apiOk: number;
  apiFailed: number;
}

const traces = new AsyncLocalStorage<UpdateTrace>();

/** Имя команды без `@бот` и без аргумента: `/task`. Текст после команды — текст людей, он сюда не входит. */
export function commandOf(ctx: Context): string | null {
  const message = ctx.message;
  if (message?.text === undefined) return null;
  const entity = message.entities?.[0];
  if (entity === undefined || entity.type !== 'bot_command' || entity.offset !== 0) return null;
  const name = message.text.slice(0, entity.length).split('@')[0] ?? '';
  return COMMAND_NAME.test(name) ? name : null;
}

/** Вид callback — ведущие части из букв: `task:mark`, `ma`. ID проекта, человека и номер задачи не входят. */
function callbackKind(data: string | undefined): string | null {
  if (data === undefined) return null;
  const kind: string[] = [];
  for (const part of data.split(':')) {
    if (!CALLBACK_KIND_PART.test(part)) break;
    kind.push(part);
  }
  return kind.length === 0 ? null : kind.join(':');
}

function updateKind(ctx: Context): string {
  return Object.keys(ctx.update).find((key) => key !== 'update_id') ?? 'update';
}

function updateFields(ctx: Context): LogFields {
  const chat = ctx.chat;
  const from = ctx.from;
  return {
    updateId: ctx.update.update_id,
    kind: updateKind(ctx),
    chatId: chat === undefined ? null : String(chat.id),
    chatType: chat?.type ?? null,
    topicId: ctx.msg?.message_thread_id ?? null,
    fromId: from === undefined ? null : String(from.id),
    command: commandOf(ctx),
    callback: callbackKind(ctx.callbackQuery?.data),
  };
}

function outcomeOf(trace: UpdateTrace): Outcome {
  if (trace.denied) return 'denied';
  if (trace.refusal !== null) return 'refused';
  if (trace.handler === null) return 'unhandled';
  return trace.apiOk > 0 ? 'replied' : 'silent';
}

function chatOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('chat_id' in payload)) return null;
  const chat = payload.chat_id;
  return typeof chat === 'number' || typeof chat === 'string' ? String(chat) : null;
}

/** Строка на каждый вызов Bot API: метод, чат, успех или код ошибки. Тело запроса и ответа не пишется. */
function botApiLog(logger: Logger, clock: Clock): Transformer {
  return async (prev, method, payload, signal) => {
    const startedAt = clock.now().getTime();
    const trace = traces.getStore();
    const call = { method, chatId: chatOf(payload), updateId: trace?.updateId ?? null };
    const elapsed = () => clock.now().getTime() - startedAt;
    try {
      const response = await prev(method, payload, signal);
      if (response.ok) {
        if (trace !== undefined) trace.apiOk += 1;
        logger.info(STEP_API, { ...call, ok: true, durationMs: elapsed() });
        return response;
      }
      if (trace !== undefined) trace.apiFailed += 1;
      const kind = telegramFailureKind({ rateLimited: response.error_code === RATE_LIMITED, edit: method.startsWith('edit') });
      const fields = {
        ...call,
        ok: false,
        errorCode: response.error_code,
        retryAfter: response.parameters?.retry_after ?? null,
        kind,
        durationMs: elapsed(),
      };
      if (kind === 'edit_rejected') logger.warn(STEP_API, fields, response.description);
      else logger.error(STEP_API, fields, response.description);
      return response;
    } catch (error) {
      if (trace !== undefined) trace.apiFailed += 1;
      logger.error(STEP_API, { ...call, ok: false, errorCode: null, retryAfter: null, kind: 'other', durationMs: elapsed() }, error);
      throw error;
    }
  };
}

/**
 * Строки пути обновления (B-17): обновление на входе, решение guard, исход и вызовы Bot API.
 * Подключается первым, до guard: так строку получает и обновление постороннего.
 */
export function attachUpdateLog(bot: Bot, logger: Logger, clock: Clock): void {
  bot.api.config.use(botApiLog(logger, clock));
  bot.use(async (ctx, next) => {
    const startedAt = clock.now().getTime();
    const trace: UpdateTrace = {
      logger,
      updateId: ctx.update.update_id,
      handler: null,
      denied: false,
      refusal: null,
      apiOk: 0,
      apiFailed: 0,
    };
    logger.info(STEP_UPDATE, updateFields(ctx));
    const result = (outcome: Outcome, code: DomainErrorCode | null): LogFields => ({
      updateId: trace.updateId,
      handler: trace.handler,
      outcome,
      code,
      apiOk: trace.apiOk,
      apiFailed: trace.apiFailed,
      durationMs: clock.now().getTime() - startedAt,
    });
    try {
      await traces.run(trace, next);
    } catch (error) {
      logger.error(STEP_OUTCOME, result('failed', error instanceof DomainError ? error.code : trace.refusal), error);
      throw error;
    }
    logger.info(STEP_OUTCOME, result(outcomeOf(trace), trace.refusal));
  });
}

export function traceGuard(decision: GuardDecision, basis: GuardBasis): void {
  const trace = traces.getStore();
  if (trace === undefined) return;
  if (decision === 'deny') trace.denied = true;
  trace.logger.info(STEP_GUARD, { updateId: trace.updateId, decision, basis });
}

/** Обработчик узнал своё обновление. Первый взявший остаётся в строке исхода. */
export function traceHandler(name: GuardedHandler): void {
  const trace = traces.getStore();
  if (trace === undefined || trace.handler !== null) return;
  trace.handler = name;
}

/** Отказ домена, который обработчик превратил в ответ или в молчание. В строку идёт только код. */
export function traceRefusal(error: unknown): void {
  const trace = traces.getStore();
  if (trace === undefined || !(error instanceof DomainError)) return;
  trace.refusal = error.code;
}
