import type { Bot } from 'grammy';
import type { TaskMarking, TaskMarkResult } from '../domain/tasks/check-task.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { TASK_MARK_ACTION } from '../projections/tasks-block.ts';
import { canvasRedrawFailure, CANVAS_FULL_REPLY, type CanvasRedraw, type TaskCommandPlace } from './task-command.ts';

const MARK_DATA = new RegExp(`^task:${TASK_MARK_ACTION}:([1-9]\\d*)$`);

/** Номер задачи из callback кружка. Чужой callback сюда не попадает. */
export function parseTaskMarkData(data: string): number | null {
  const match = MARK_DATA.exec(data);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) return null;
  return number;
}

function refusal(error: DomainError): boolean {
  switch (error.code) {
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.TASK_MARK_ACTOR:
    case DOMAIN_ERROR.TASK_MARK_ABSENT:
    case DOMAIN_ERROR.TASK_AMBIGUOUS:
    case DOMAIN_ERROR.TASK_TRANSITION:
    case DOMAIN_ERROR.TASK_NUMBER:
    case DOMAIN_ERROR.TASK_IDEMPOTENCY_KEY:
      return true;
    default:
      return false;
  }
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

/**
 * Нажатие кружка меняет статус. Строка станет отмеченной, когда канвас перерисуется.
 * Чужой человек, запрещённый переход и пустой ключ статус не меняют.
 */
export async function replyToTaskMark(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  taskNumber: number,
  actions: TaskMarking,
): Promise<TaskMarkResult | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    return await actions.press({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      taskNumber,
      idempotencyKey,
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (refusal(error)) return null;
    throw error;
  }
}

/** Кнопка кружка на единственном экземпляре grammY. */
export function attachTaskMark(bot: Bot, actions: TaskMarking, canvas?: CanvasRedraw): void {
  bot.callbackQuery(new RegExp(`^task:${TASK_MARK_ACTION}:`), async (ctx) => {
    const number = parseTaskMarkData(ctx.callbackQuery.data);
    const from = ctx.from;
    const message = ctx.callbackQuery.message;
    const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
    let notice: { text: string } | undefined;
    try {
      if (number === null || from.is_bot) return;
      const marked = await replyToTaskMark(
        {
          type: ctx.chat?.type,
          id: ctx.chat === undefined ? undefined : String(ctx.chat.id),
          topicId,
        },
        from,
        ctx.callbackQuery.id,
        number,
        actions,
      );
      if (marked !== null && canvas !== undefined) {
        try {
          await canvas.redraw({
            projectId: marked.task.projectId,
            assigneeId: marked.task.assigneeId,
            causationId: marked.eventId,
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
