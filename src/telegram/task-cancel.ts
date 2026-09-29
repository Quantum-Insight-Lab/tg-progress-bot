import type { Bot } from 'grammy';
import type { TaskCancelling, TaskCancelResult } from '../domain/tasks/cancel-task.ts';
import { TASK_TRANSITION_CANCEL } from '../domain/tasks/transition.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { canvasRedrawFailure, CANVAS_FULL_REPLY, type CanvasRedraw, type TaskCommandPlace } from './task-command.ts';

const CANCEL_DATA = new RegExp(`^task:${TASK_TRANSITION_CANCEL}:([1-9]\\d*)$`);

/** Номер задачи из callback «отменить». Чужой callback сюда не попадает. */
export function parseTaskCancelData(data: string): number | null {
  const match = CANCEL_DATA.exec(data);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const taskNumber = Number(raw);
  if (!Number.isSafeInteger(taskNumber)) return null;
  return taskNumber;
}

function refusal(error: DomainError): boolean {
  switch (error.code) {
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.TASK_CANCEL_ACTOR:
    case DOMAIN_ERROR.TASK_CANCEL_ABSENT:
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
 * «Отменить» переводит задачу в `CANCELLED`. Строка уходит с канваса, когда он перерисуется.
 * Чужой человек, `DONE` и пустой ключ задачу не меняют.
 */
export async function replyToTaskCancel(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  taskNumber: number,
  actions: TaskCancelling,
): Promise<TaskCancelResult | null> {
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

/** Кнопка «отменить» на единственном экземпляре grammY. */
export function attachTaskCancel(bot: Bot, actions: TaskCancelling, canvas?: CanvasRedraw): void {
  bot.callbackQuery(new RegExp(`^task:${TASK_TRANSITION_CANCEL}:`), async (ctx) => {
    const taskNumber = parseTaskCancelData(ctx.callbackQuery.data);
    const from = ctx.from;
    const message = ctx.callbackQuery.message;
    const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
    let notice: { text: string } | undefined;
    try {
      if (taskNumber === null || from.is_bot) return;
      const cancelled = await replyToTaskCancel(
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
      if (cancelled !== null && canvas !== undefined) {
        try {
          await canvas.redraw({
            projectId: cancelled.task.projectId,
            assigneeId: cancelled.task.assigneeId,
            causationId: cancelled.eventId,
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
