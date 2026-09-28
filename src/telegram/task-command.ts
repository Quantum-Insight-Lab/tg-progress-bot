import type { Bot } from 'grammy';
import type { TaskCreation } from '../domain/tasks/create-task.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** Отказ, если команда пришла не из топика того, кто пишет. */
export const TASK_OWN_TOPIC = 'Задачу заводят командой /task в своём топике.';

/** Команда есть, формулировки нет — названия не из чего взять. */
export const TASK_NEEDS_TITLE = 'После /task нужна формулировка: она станет названием.';

export function taskCreatedReply(number: number, title: string): string {
  return `Задача ${number}. ${title}`;
}

/**
 * `/task` и `/task@бот`. Хвост — формулировка.
 * `/tasks` и обычный текст командой не считаются.
 */
export function parseTaskCommand(text: string): string | null {
  const match = /^\/task(?![A-Za-z0-9_])(?:@[A-Za-z0-9_]+)?([\s\S]*)$/.exec(text);
  if (match === null) return null;
  return (match[1] ?? '').trim();
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export interface TaskCommandPlace {
  type: string | undefined;
  id: string | undefined;
  topicId: number | undefined;
}

function replyOf(error: DomainError): string | null {
  switch (error.code) {
    case DOMAIN_ERROR.TASK_DUPLICATE:
      return null;
    case DOMAIN_ERROR.TASK_TITLE_BLANK:
      return TASK_NEEDS_TITLE;
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.TASK_ASSIGNEE_ROLE:
    case DOMAIN_ERROR.TASK_AMBIGUOUS:
      return TASK_OWN_TOPIC;
    default:
      throw error;
  }
}

/** После `task.created` канвас того же дня правится или появляется, если его ещё не было. */
export interface CanvasRedraw {
  redraw(input: { projectId: string; assigneeId: string; causationId: string }): Promise<void>;
}

/**
 * Команда в топике заводит задачу и возвращает ответ.
 * Чужой топик, личка и пустая формулировка задачу не пишут.
 */
export async function replyToTaskCommand(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  title: string,
  actions: TaskCreation,
  canvas?: CanvasRedraw,
): Promise<string | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    const created = await actions.create({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      title,
      idempotencyKey,
    });
    if (canvas !== undefined) {
      await canvas.redraw({
        projectId: created.task.projectId,
        assigneeId: created.task.assigneeId,
        causationId: created.eventId,
      });
    }
    return taskCreatedReply(created.task.number, created.task.title);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return replyOf(error);
  }
}

/** Команда `/task` на единственном экземпляре grammY. */
export function attachTaskCommand(bot: Bot, actions: TaskCreation, canvas?: CanvasRedraw): void {
  bot.command('task', async (ctx) => {
    const title = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    const chat = ctx.chat;
    const reply = await replyToTaskCommand(
      {
        type: chat?.type,
        id: chat === undefined ? undefined : String(chat.id),
        topicId: ctx.message?.message_thread_id,
      },
      ctx.from,
      String(ctx.update.update_id),
      title,
      actions,
      canvas,
    );
    if (reply !== null) await ctx.reply(reply);
  });
}
