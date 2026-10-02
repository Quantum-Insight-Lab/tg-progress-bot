import { InlineKeyboard, type Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { ScheduleActions, ScheduleBoard } from '../domain/projects/schedule.ts';
import { offsetLabel } from '../domain/shared/utc-offset.ts';
import { withParticipantsStep } from '../projections/onboarding-next.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Строка настроек: время отчёта группы. */
export const SCHEDULE_HEADING = 'Время отчёта';

export const SCHEDULE_ASK = 'Время ежедневной отправки.';

export const SCHEDULE_OFF = 'Пока время не названо, расписание выключено.';

export const SCHEDULE_ON = 'Рассылка включена.';

export const SCHEDULE_OFF_LABEL = 'Выключить';

export const SCHEDULE_UNBOUND = 'Пока супергруппа не привязана, расписания нет.';

export const SCHEDULE_ACCESS = 'Нет доступа.';

export const SCHEDULE_ACTOR = 'Время отчёта задаёт руководитель.';

export const SCHEDULE_ROOT_ONLY = 'Время отчёта меняет корень.';

export const SCHEDULE_CLEAR_ROOT = 'Рассылку выключает корень.';

export const SCHEDULE_NO_PROJECT = 'Такого проекта нет.';

export const SCHEDULE_AMBIGUOUS_PROJECT = 'Уточните проект: имя совпало у нескольких.';

export const SCHEDULE_NEED_BOTH = 'Нужны время ежедневной отправки и таймзона группы.';

export const SCHEDULE_CLEARED = 'Время стёрто. Рассылка выключена.';

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export type ScheduleRequest =
  | { kind: 'show'; projectName: string }
  | { kind: 'set'; projectName: string; dailyTime: string }
  | { kind: 'clear'; projectName: string };

/** Три строки: имя проекта и час отчёта. Сдвиг группы уже записан. */
export function scheduleTemplate(projectName: string): string {
  return [SCHEDULE_HEADING, projectName, '<время>'].join('\n');
}

/** Вопрос сразу после командного топика: время и таймзона, пока время пустое — рассылка выключена. */
export function afterReportsTopic(done: string): string {
  return [done, '', SCHEDULE_ASK, SCHEDULE_OFF, scheduleTemplate('<проект>')].join('\n');
}

export function scheduleSavedReply(dailyTime: string, timezone: string, projectName: string): string {
  return withParticipantsStep(
    `Время отчёта группы: ${dailyTime}. Таймзона группы: ${timezone}. ${SCHEDULE_ON}`,
    projectName,
  );
}

export function renderSchedule(view: { projectName: string; bound: boolean; dailyTime: string | null; timezone: string | null; mailing: boolean }): string {
  const lines = [SCHEDULE_HEADING, view.projectName, ''];
  if (!view.bound) {
    lines.push(SCHEDULE_UNBOUND);
    return lines.join('\n');
  }
  if (!view.mailing || view.dailyTime === null || view.timezone === null) {
    lines.push(SCHEDULE_OFF, SCHEDULE_ASK, scheduleTemplate(view.projectName));
    return lines.join('\n');
  }
  lines.push(
    `Время отчёта группы: ${view.dailyTime}`,
    `Таймзона группы: ${offsetLabel(view.timezone)}`,
    SCHEDULE_ON,
    scheduleTemplate(view.projectName),
  );
  return lines.join('\n');
}

/** «Время отчёта» и имя проекта, либо те же строки плюс время и таймзона. Пустое время стирает расписание. */
export function parseScheduleMessage(text: string): ScheduleRequest | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== SCHEDULE_HEADING) return null;
  const projectName = lines[1]?.trim() ?? '';
  if (projectName.length === 0) return null;
  if (lines.length === 2) return { kind: 'show', projectName };
  if (lines.length !== 3) return null;
  const dailyTime = lines[2]?.trim() ?? '';
  if (dailyTime.length === 0) return { kind: 'clear', projectName };
  return { kind: 'set', projectName, dailyTime };
}

export function clearScheduleData(projectId: string): string {
  return `so:${projectId}`;
}

export function parseClearScheduleData(data: string): string | null {
  const match = /^so:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(data);
  return match?.[1] ?? null;
}

/** Кнопка есть, только пока рассылка включена. */
export function scheduleKeyboard(view: { mailing: boolean; projectId: string }): InlineKeyboard | undefined {
  if (!view.mailing) return undefined;
  return new InlineKeyboard().text(SCHEDULE_OFF_LABEL, clearScheduleData(view.projectId));
}

export interface ScheduleScreen {
  text: string;
  markup?: InlineKeyboard;
}

function replyOf(error: unknown): string | null {
  traceRefusal(error);
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.SCHEDULE_DUPLICATE:
    case DOMAIN_ERROR.SCHEDULE_CHAT:
      return null;
    case DOMAIN_ERROR.SCHEDULE_ACCESS:
      return SCHEDULE_ACCESS;
    case DOMAIN_ERROR.SCHEDULE_ACTOR:
      return SCHEDULE_ACTOR;
    case DOMAIN_ERROR.SCHEDULE_ROOT:
      return SCHEDULE_ROOT_ONLY;
    case DOMAIN_ERROR.SCHEDULE_CLEAR:
      return SCHEDULE_CLEAR_ROOT;
    case DOMAIN_ERROR.SCHEDULE_PROJECT_MISSING:
      return SCHEDULE_NO_PROJECT;
    case DOMAIN_ERROR.SCHEDULE_PROJECT_AMBIGUOUS:
      return SCHEDULE_AMBIGUOUS_PROJECT;
    case DOMAIN_ERROR.SCHEDULE_UNBOUND:
      return SCHEDULE_UNBOUND;
    case DOMAIN_ERROR.SCHEDULE_TIME_BLANK:
    case DOMAIN_ERROR.SCHEDULE_TIMEZONE_BLANK:
      return SCHEDULE_NEED_BOTH;
    default:
      throw error;
  }
}

function inPrivate(chatType: string | undefined, from: TelegramAccount | undefined): chatType is typeof PRIVATE_CHAT {
  return chatType === PRIVATE_CHAT && from !== undefined && !from.is_bot;
}

function textOf(view: ScheduleBoard): string {
  return renderSchedule({
    projectName: view.project.name,
    bound: view.bound,
    dailyTime: view.dailyTime,
    timezone: view.timezone,
    mailing: view.mailing,
  });
}

function screenOf(view: ScheduleBoard): ScheduleScreen {
  const text = textOf(view);
  const markup = scheduleKeyboard({ mailing: view.mailing, projectId: view.project.id });
  if (markup === undefined) return { text };
  return { text, markup };
}

/** Экран времени отчёта в личке. Вне лички молчит. */
export async function replyToScheduleMessage(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: ScheduleRequest,
  idempotencyKey: string,
  actions: ScheduleActions,
): Promise<ScheduleScreen | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    if (request.kind === 'show') {
      const view = await actions.show({ telegramUserId: String(from.id), projectName: request.projectName, chat: chatType });
      return screenOf(view);
    }
    if (request.kind === 'clear') {
      const outcome = await actions.clear({
        telegramUserId: String(from.id),
        projectName: request.projectName,
        chat: chatType,
        idempotencyKey,
      });
      if (!outcome.changed) return { text: SCHEDULE_OFF };
      return { text: SCHEDULE_CLEARED };
    }
    const outcome = await actions.set({
      telegramUserId: String(from.id),
      projectName: request.projectName,
      dailyTime: request.dailyTime,
      chat: chatType,
      idempotencyKey,
    });
    if (outcome.board.dailyTime === null || outcome.board.timezone === null) return { text: SCHEDULE_NEED_BOTH };
    return { text: scheduleSavedReply(outcome.board.dailyTime, outcome.board.timezone, outcome.board.project.name) };
  } catch (error) {
    const text = replyOf(error);
    if (text === null) return null;
    return { text };
  }
}

/** Нажатие «Выключить»: то же стирание времени, что и пустая третья строка. */
export async function replyToClearSchedule(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  projectId: string,
  idempotencyKey: string,
  actions: ScheduleActions,
): Promise<ScheduleScreen | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  try {
    const outcome = await actions.clearById({
      telegramUserId: String(from.id),
      projectId,
      chat: chatType,
      idempotencyKey,
    });
    if (!outcome.changed) return { text: SCHEDULE_OFF };
    return { text: SCHEDULE_CLEARED };
  } catch (error) {
    const text = replyOf(error);
    if (text === null) return null;
    return { text };
  }
}

function send(ctx: { reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown> }, screen: ScheduleScreen): Promise<unknown> {
  if (screen.markup === undefined) return ctx.reply(screen.text);
  return ctx.reply(screen.text, { reply_markup: screen.markup });
}

/** «Время отчёта» в личке: вопрос, запись времени или кнопка «Выключить». */
export function attachSchedule(bot: Bot, actions: ScheduleActions): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const request = parseScheduleMessage(text);
    if (request === null) {
      await next();
      return;
    }
    traceHandler('schedule');
    const reply = await replyToScheduleMessage(ctx.chat?.type, ctx.from, request, String(ctx.update.update_id), actions);
    if (reply !== null) await send(ctx, reply);
    await next();
  });

  bot.callbackQuery(/^so:/, async (ctx) => {
    traceHandler('schedule');
    await ctx.answerCallbackQuery();
    const projectId = parseClearScheduleData(ctx.callbackQuery.data);
    if (projectId === null || ctx.from.is_bot) return;
    const reply = await replyToClearSchedule(ctx.chat?.type, ctx.from, projectId, String(ctx.update.update_id), actions);
    if (reply !== null) await send(ctx, reply);
  });
}

