import type { Bot } from 'grammy';
import type { BlockerAnswering, BlockerReasonResult, NoBlockerResult } from '../domain/tasks/blocker-answer.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { blockerQuestionReply, parseNoBlockerData } from '../projections/blocker-question.ts';
import { canvasRedrawFailure, CANVAS_FULL_REPLY, type CanvasRedraw, type TaskCommandPlace } from './task-command.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export interface BlockerReplyTarget {
  messageId: number;
  text: string | undefined;
  fromBot: boolean;
}

function refusal(error: DomainError): boolean {
  switch (error.code) {
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.BLOCKER_ACTOR:
    case DOMAIN_ERROR.BLOCKER_ABSENT:
    case DOMAIN_ERROR.BLOCKER_REPLY:
    case DOMAIN_ERROR.BLOCKER_REASON:
    case DOMAIN_ERROR.TASK_AMBIGUOUS:
    case DOMAIN_ERROR.TASK_TRANSITION:
    case DOMAIN_ERROR.TASK_NUMBER:
    case DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY:
      return true;
    default:
      return false;
  }
}

/**
 * Reply на вопрос бота записывает причину. Другой текст причину не задаёт.
 */
export async function replyToBlockerReason(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  text: string,
  reply: BlockerReplyTarget | null,
  actions: BlockerAnswering,
): Promise<BlockerReasonResult | null> {
  if (from === undefined || from.is_bot || reply === null) return null;
  const question = blockerQuestionReply({
    replyToMessageId: reply.messageId,
    repliedText: reply.text ?? null,
    fromBot: reply.fromBot,
  });
  if (question === null) return null;
  traceHandler('blocker-answer');
  try {
    return await actions.declare({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      taskNumber: question.taskNumber,
      reason: text,
      replyToMessageId: question.replyToMessageId,
      questionTaskNumber: question.taskNumber,
      idempotencyKey,
    });
  } catch (error) {
    traceRefusal(error);
    if (!(error instanceof DomainError)) throw error;
    if (refusal(error)) return null;
    throw error;
  }
}

/**
 * «Нет блокера» возвращает задачу в `IN_PROGRESS`.
 * Чужой человек и повтор того же callback задачу не меняют.
 */
export async function replyToNoBlocker(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  taskNumber: number,
  actions: BlockerAnswering,
): Promise<NoBlockerResult | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    return await actions.dismiss({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      taskNumber,
      idempotencyKey,
    });
  } catch (error) {
    traceRefusal(error);
    if (!(error instanceof DomainError)) throw error;
    if (refusal(error)) return null;
    throw error;
  }
}

/** Reply с причиной и кнопка «нет блокера» на единственном экземпляре grammY. */
export function attachBlockerAnswer(bot: Bot, actions: BlockerAnswering, canvas?: CanvasRedraw): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined || ctx.message === undefined) {
      await next();
      return;
    }
    const reply = ctx.message.reply_to_message;
    const answered = await replyToBlockerReason(
      {
        type: ctx.chat?.type,
        id: ctx.chat === undefined ? undefined : String(ctx.chat.id),
        topicId: ctx.message.message_thread_id,
      },
      ctx.from,
      String(ctx.update.update_id),
      text,
      reply === undefined
        ? null
        : {
            messageId: reply.message_id,
            text: 'text' in reply ? reply.text : undefined,
            fromBot: reply.from?.is_bot === true,
          },
      actions,
    );
    if (answered === null) await next();
  });

  bot.callbackQuery(/^task:noblock:/, async (ctx) => {
    traceHandler('blocker-answer');
    const taskNumber = parseNoBlockerData(ctx.callbackQuery.data);
    const from = ctx.from;
    const message = ctx.callbackQuery.message;
    const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
    let notice: { text: string } | undefined;
    try {
      if (taskNumber === null || from.is_bot) return;
      const dismissed = await replyToNoBlocker(
        {
          type: ctx.chat?.type,
          id: ctx.chat === undefined ? undefined : String(ctx.chat.id),
          topicId,
        },
        from,
        ctx.callbackQuery.id,
        taskNumber,
        actions,
      );
      if (dismissed !== null && dismissed.applied && canvas !== undefined) {
        try {
          await canvas.redraw({
            projectId: dismissed.task.projectId,
            assigneeId: dismissed.task.assigneeId,
            causationId: dismissed.eventId,
            cause: String(ctx.update.update_id),
          });
        } catch (error) {
          const failure = canvasRedrawFailure(error);
          if (failure === null) throw error;
          if (failure === 'full') notice = { text: CANVAS_FULL_REPLY };
        }
      }
    } finally {
      await ctx.answerCallbackQuery(notice);
    }
  });
}
