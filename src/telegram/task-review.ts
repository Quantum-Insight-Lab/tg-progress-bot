import type { Bot } from 'grammy';
import type { TaskReviewing, TaskReviewResult } from '../domain/tasks/review-task.ts';
import { TASK_TRANSITION_CONFIRM, TASK_TRANSITION_RETURN } from '../domain/tasks/transition.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { canvasRedrawFailure, CANVAS_FULL_REPLY, type CanvasRedraw, type TaskCommandPlace } from './task-command.ts';

const REVIEW_DATA = new RegExp(`^task:(${TASK_TRANSITION_CONFIRM}|${TASK_TRANSITION_RETURN}):([1-9]\\d*)$`);

/** Номер задачи и акт из callback «подтвердить» или «вернуть». Чужой callback сюда не попадает. */
export function parseTaskReviewData(data: string): { act: string; taskNumber: number } | null {
  const match = REVIEW_DATA.exec(data);
  const act = match?.[1];
  const raw = match?.[2];
  if (act === undefined || raw === undefined) return null;
  const taskNumber = Number(raw);
  if (!Number.isSafeInteger(taskNumber)) return null;
  return { act, taskNumber };
}

function refusal(error: DomainError): boolean {
  switch (error.code) {
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.TASK_CONFIRM_ACTOR:
    case DOMAIN_ERROR.TASK_REVIEW_ABSENT:
    case DOMAIN_ERROR.TASK_OPEN_BLOCKER:
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
 * «Подтвердить» и «вернуть» меняют статус. Строка уйдёт с канваса, когда он перерисуется.
 * Чужой человек, запрещённый переход и пустой ключ статус не меняют.
 */
export async function replyToTaskReview(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  taskNumber: number,
  act: string,
  actions: TaskReviewing,
): Promise<TaskReviewResult | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    return await actions.press({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      taskNumber,
      act,
      idempotencyKey,
    });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (refusal(error)) return null;
    throw error;
  }
}

/** Кнопки «подтвердить» и «вернуть» на единственном экземпляре grammY. */
export function attachTaskReview(bot: Bot, actions: TaskReviewing, canvas?: CanvasRedraw): void {
  bot.callbackQuery(new RegExp(`^task:(?:${TASK_TRANSITION_CONFIRM}|${TASK_TRANSITION_RETURN}):`), async (ctx) => {
    const parsed = parseTaskReviewData(ctx.callbackQuery.data);
    const from = ctx.from;
    const message = ctx.callbackQuery.message;
    const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
    let notice: { text: string } | undefined;
    try {
      if (parsed === null || from.is_bot) return;
      const reviewed = await replyToTaskReview(
        {
          type: ctx.chat?.type,
          id: ctx.chat === undefined ? undefined : String(ctx.chat.id),
          topicId,
        },
        from,
        ctx.callbackQuery.id,
        parsed.taskNumber,
        parsed.act,
        actions,
      );
      if (reviewed !== null && canvas !== undefined) {
        try {
          await canvas.redraw({
            projectId: reviewed.task.projectId,
            assigneeId: reviewed.task.assigneeId,
            causationId: reviewed.eventId,
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
