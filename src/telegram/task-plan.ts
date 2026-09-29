import type { Bot } from 'grammy';
import type { TaskPlanResult, TaskPlanning } from '../domain/tasks/plan-task.ts';
import { TASK_TRANSITION_PLAN, TASK_TRANSITION_RESUME } from '../domain/tasks/transition.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { TASK_PRIORITY_ACTION } from '../projections/tasks-block.ts';
import { canvasRedrawFailure, CANVAS_FULL_REPLY, type CanvasRedraw, type TaskCommandPlace } from './task-command.ts';

const STEER_DATA = new RegExp(
  `^task:(${TASK_TRANSITION_PLAN}|${TASK_TRANSITION_RESUME}|${TASK_PRIORITY_ACTION}):([1-9]\\d*)$`,
);

/** Номер задачи и акт из callback «в план», «в работу» или слова приоритета. */
export function parseTaskPlanData(data: string): { act: string; taskNumber: number } | null {
  const match = STEER_DATA.exec(data);
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
    case DOMAIN_ERROR.TASK_PLAN_ACTOR:
    case DOMAIN_ERROR.TASK_PLAN_ABSENT:
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
 * «В план», «в работу» и слово приоритета меняют задачу. Канвас того же дня перерисовывается.
 * Руководитель, чужой участник, запрещённый переход и пустой ключ задачу не меняют.
 */
export async function replyToTaskPlan(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  taskNumber: number,
  act: string,
  actions: TaskPlanning,
): Promise<TaskPlanResult | null> {
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

/** Кнопки «в план», «в работу» и слова приоритета на единственном экземпляре grammY. */
export function attachTaskPlan(bot: Bot, actions: TaskPlanning, canvas?: CanvasRedraw): void {
  bot.callbackQuery(
    new RegExp(`^task:(?:${TASK_TRANSITION_PLAN}|${TASK_TRANSITION_RESUME}|${TASK_PRIORITY_ACTION}):`),
    async (ctx) => {
      const parsed = parseTaskPlanData(ctx.callbackQuery.data);
      const from = ctx.from;
      const message = ctx.callbackQuery.message;
      const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
      let notice: { text: string } | undefined;
      try {
        if (parsed === null || from.is_bot) return;
        const steered = await replyToTaskPlan(
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
        if (steered !== null && canvas !== undefined) {
          try {
            await canvas.redraw({
              projectId: steered.task.projectId,
              assigneeId: steered.task.assigneeId,
              causationId: steered.eventId,
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
    },
  );
}
