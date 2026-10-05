import { InlineKeyboard, type Bot } from 'grammy';
import type { CreatedTask, OpenedTask, TaskCreation, TaskProjectChoice } from '../domain/tasks/create-task.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { noteCommandRejection } from './rejection.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Отказ, если команда пришла не из топика того, кто пишет. */
export const TASK_OWN_TOPIC = 'Задачу заводят командой /task в своём топике.';

/** Команда есть, формулировки нет — названия не из чего взять. */
export const TASK_NEEDS_TITLE = 'После /task нужна формулировка: она станет названием.';

/** В топике несколько проектов этого человека: задачу пишет кнопка. */
export const TASK_PICK_PROJECT = 'Куда записать задачу?';

const BUTTON_TEXT_LIMIT = 64;
const PROJECT_DATA = /^tp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Ответ с кнопками проектов. Формулировка остаётся в команде, на которую отвечаем. */
export interface TaskProjectScreen {
  text: string;
  projects: readonly TaskProjectChoice[];
}

export function taskCreatedReply(number: number, title: string): string {
  return `Задача ${number}. ${title}`;
}

export function taskProjectData(projectId: string): string {
  return `tp:${projectId}`;
}

export function parseTaskProjectData(data: string): string | null {
  return PROJECT_DATA.exec(data)?.[1] ?? null;
}

function buttonLabel(name: string): string {
  return name.length > BUTTON_TEXT_LIMIT ? name.slice(0, BUTTON_TEXT_LIMIT) : name;
}

/** Кнопка на каждый проект топика. Подпись — имя проекта. */
export function taskProjectKeyboard(projects: readonly TaskProjectChoice[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  projects.forEach((project, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(buttonLabel(project.name), taskProjectData(project.projectId));
  });
  return keyboard;
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
  messageId?: number;
}

/** Сообщение callback. Проект кнопки берётся из канваса с этим `message_id`. */
export function callbackMessageId(message: object | undefined): number | undefined {
  if (message === undefined || !('message_id' in message)) return undefined;
  const messageId = message.message_id;
  return typeof messageId === 'number' ? messageId : undefined;
}

function replyOf(error: DomainError): string | null {
  traceRefusal(error);
  switch (error.code) {
    case DOMAIN_ERROR.TASK_DUPLICATE:
      return null;
    case DOMAIN_ERROR.TASK_TITLE_BLANK:
      return TASK_NEEDS_TITLE;
    case DOMAIN_ERROR.TASK_PLACE:
    case DOMAIN_ERROR.TASK_ASSIGNEE_ROLE:
    case DOMAIN_ERROR.TASK_AMBIGUOUS:
      return TASK_OWN_TOPIC;
    case DOMAIN_ERROR.CANVAS_FULL:
      return CANVAS_FULL_REPLY;
    case DOMAIN_ERROR.CANVAS_DUPLICATE:
      return null;
    default:
      throw error;
  }
}

/** Ответ человеку, когда задачи в лимит rich message уже не влезают. */
export const CANVAS_FULL_REPLY = 'канвас заполнен';

/** После `task.created` канвас того же дня правится или появляется, если его ещё не было. */
export interface CanvasRedraw {
  redraw(input: { projectId: string; assigneeId: string; causationId: string; cause?: string }): Promise<void>;
}

/** Повтор правки молчит. Отказ «канвас заполнен» доходит до человека. */
export function canvasRedrawFailure(error: unknown): 'duplicate' | 'full' | null {
  if (!(error instanceof DomainError)) return null;
  if (error.code !== DOMAIN_ERROR.CANVAS_DUPLICATE && error.code !== DOMAIN_ERROR.CANVAS_FULL) return null;
  traceRefusal(error);
  return error.code === DOMAIN_ERROR.CANVAS_DUPLICATE ? 'duplicate' : 'full';
}

async function finishCreated(
  created: CreatedTask,
  idempotencyKey: string,
  canvas: CanvasRedraw | undefined,
): Promise<string> {
  if (canvas !== undefined) {
    await canvas.redraw({
      projectId: created.task.projectId,
      assigneeId: created.task.assigneeId,
      causationId: created.eventId,
      cause: idempotencyKey,
    });
  }
  return taskCreatedReply(created.task.number, created.task.title);
}

function screenOf(opened: Extract<OpenedTask, { kind: 'choose' }>): TaskProjectScreen {
  return { text: TASK_PICK_PROJECT, projects: opened.projects };
}

/**
 * Команда в топике заводит задачу и возвращает ответ.
 * Чужой топик, личка и пустая формулировка задачу не пишут.
 * Несколько своих проектов в топике задачу не пишут: ответ — кнопки.
 */
export async function replyToTaskCommand(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  title: string,
  actions: TaskCreation,
  canvas?: CanvasRedraw,
): Promise<string | TaskProjectScreen | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    const opened = await actions.open({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      title,
      idempotencyKey,
    });
    if (opened.kind === 'choose') return screenOf(opened);
    return finishCreated({ task: opened.task, eventId: opened.eventId }, idempotencyKey, canvas);
  } catch (error) {
    if (error instanceof DomainError) await noteCommandRejection(error, idempotencyKey, String(from.id));
    if (!(error instanceof DomainError)) throw error;
    return replyOf(error);
  }
}

/** Кнопка проекта дописывает задачу той команды `/task`, которая уже назвала формулировку. */
export async function replyToTaskProject(
  place: TaskCommandPlace,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  title: string,
  projectId: string,
  actions: TaskCreation,
  canvas?: CanvasRedraw,
): Promise<string | null> {
  if (from === undefined || from.is_bot) return null;
  try {
    const created = await actions.pick({
      telegramUserId: String(from.id),
      chat: place.type ?? '',
      telegramChatId: place.id ?? '',
      topicId: place.topicId ?? null,
      title,
      projectId,
      idempotencyKey,
    });
    return finishCreated(created, idempotencyKey, canvas);
  } catch (error) {
    if (error instanceof DomainError) await noteCommandRejection(error, idempotencyKey, String(from.id));
    if (!(error instanceof DomainError)) throw error;
    return replyOf(error);
  }
}

/** Команда `/task` на единственном экземпляре grammY. */
export function attachTaskCommand(bot: Bot, actions: TaskCreation, canvas?: CanvasRedraw): void {
  bot.command('task', async (ctx) => {
    traceHandler('task');
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
    if (reply === null) return;
    if (typeof reply === 'string') {
      await ctx.reply(reply);
      return;
    }
    const messageId = ctx.message?.message_id;
    await ctx.reply(reply.text, {
      reply_markup: taskProjectKeyboard(reply.projects),
      ...(messageId === undefined ? {} : { reply_parameters: { message_id: messageId } }),
    });
  });
  bot.callbackQuery(/^tp:/, async (ctx) => {
    traceHandler('task-project');
    const projectId = parseTaskProjectData(ctx.callbackQuery.data);
    const from = ctx.from;
    const message = ctx.callbackQuery.message;
    const quoted = message !== undefined && 'reply_to_message' in message ? message.reply_to_message : undefined;
    const quotedText = quoted !== undefined && 'text' in quoted ? quoted.text : undefined;
    const title = quotedText === undefined ? null : parseTaskCommand(quotedText);
    const topicId = message !== undefined && 'message_thread_id' in message ? message.message_thread_id : undefined;
    let notice: { text: string } | undefined;
    try {
      if (projectId === null || title === null || from.is_bot) return;
      const reply = await replyToTaskProject(
        {
          type: ctx.chat?.type,
          id: ctx.chat === undefined ? undefined : String(ctx.chat.id),
          topicId,
        },
        from,
        ctx.callbackQuery.id,
        title,
        projectId,
        actions,
        canvas,
      );
      if (reply === TASK_NEEDS_TITLE || reply === CANVAS_FULL_REPLY) notice = { text: reply };
      else if (typeof reply === 'string' && reply !== TASK_OWN_TOPIC) await ctx.reply(reply);
    } catch (error) {
      const failure = canvasRedrawFailure(error);
      if (failure === null) throw error;
      if (failure === 'full') notice = { text: CANVAS_FULL_REPLY };
    } finally {
      await ctx.answerCallbackQuery(notice);
    }
  });
}
