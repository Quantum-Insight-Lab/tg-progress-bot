import type { Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { ScheduleActions, ScheduleBoard } from '../domain/projects/schedule.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** Строка настроек: время отчёта группы. */
export const SCHEDULE_HEADING = 'Время отчёта';

export const SCHEDULE_ASK = 'Время ежедневной отправки и таймзона группы.';

export const SCHEDULE_OFF = 'Пока время не названо, расписание выключено.';

export const SCHEDULE_ON = 'Рассылка включена.';

export const SCHEDULE_CLEAR_HINT = 'Чтобы выключить рассылку, время стирают: третья строка пустая.';

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
  | { kind: 'set'; projectName: string; dailyTime: string; timezone: string }
  | { kind: 'clear'; projectName: string }
  | { kind: 'need-timezone' };

/** Четыре строки: имя проекта, время, таймзона группы. */
export function scheduleTemplate(projectName: string): string {
  return [SCHEDULE_HEADING, projectName, '<время>', '<таймзона>'].join('\n');
}

/** Вопрос сразу после командного топика: время и таймзона, пока время пустое — рассылка выключена. */
export function afterReportsTopic(done: string): string {
  return [done, '', SCHEDULE_ASK, SCHEDULE_OFF, scheduleTemplate('<проект>')].join('\n');
}

export function scheduleSavedReply(dailyTime: string, timezone: string): string {
  return `Время отчёта группы: ${dailyTime}. Таймзона группы: ${timezone}. ${SCHEDULE_ON}`;
}

export function renderSchedule(view: { projectName: string; bound: boolean; dailyTime: string | null; timezone: string | null; mailing: boolean }): string {
  const lines = [SCHEDULE_HEADING, view.projectName, ''];
  if (!view.bound) {
    lines.push(SCHEDULE_UNBOUND);
    return lines.join('\n');
  }
  if (!view.mailing || view.dailyTime === null || view.timezone === null) {
    lines.push(SCHEDULE_OFF, SCHEDULE_ASK, scheduleTemplate(view.projectName), SCHEDULE_CLEAR_HINT);
    return lines.join('\n');
  }
  lines.push(
    `Время отчёта группы: ${view.dailyTime}`,
    `Таймзона группы: ${view.timezone}`,
    SCHEDULE_ON,
    SCHEDULE_CLEAR_HINT,
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
  if (lines.length === 3) {
    const dailyTime = lines[2]?.trim() ?? '';
    if (dailyTime.length === 0) return { kind: 'clear', projectName };
    return { kind: 'need-timezone' };
  }
  if (lines.length !== 4) return null;
  const dailyTime = lines[2]?.trim() ?? '';
  const timezone = lines[3]?.trim() ?? '';
  if (dailyTime.length === 0) return { kind: 'clear', projectName };
  if (timezone.length === 0) return { kind: 'need-timezone' };
  return { kind: 'set', projectName, dailyTime, timezone };
}

function replyOf(error: unknown): string | null {
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

/** Экран времени отчёта в личке. Вне лички молчит. */
export async function replyToScheduleMessage(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: ScheduleRequest,
  idempotencyKey: string,
  actions: ScheduleActions,
): Promise<string | null> {
  if (!inPrivate(chatType, from) || from === undefined) return null;
  if (request.kind === 'need-timezone') return SCHEDULE_NEED_BOTH;
  try {
    if (request.kind === 'show') {
      const view = await actions.show({ telegramUserId: String(from.id), projectName: request.projectName, chat: chatType });
      return textOf(view);
    }
    if (request.kind === 'clear') {
      const outcome = await actions.clear({
        telegramUserId: String(from.id),
        projectName: request.projectName,
        chat: chatType,
        idempotencyKey,
      });
      if (!outcome.changed) return SCHEDULE_OFF;
      return SCHEDULE_CLEARED;
    }
    const outcome = await actions.set({
      telegramUserId: String(from.id),
      projectName: request.projectName,
      dailyTime: request.dailyTime,
      timezone: request.timezone,
      chat: chatType,
      idempotencyKey,
    });
    if (outcome.board.dailyTime === null || outcome.board.timezone === null) return SCHEDULE_NEED_BOTH;
    return scheduleSavedReply(outcome.board.dailyTime, outcome.board.timezone);
  } catch (error) {
    return replyOf(error);
  }
}

/** «Время отчёта» в личке: вопрос, запись времени и таймзоны или стирание времени. */
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
    const reply = await replyToScheduleMessage(ctx.chat?.type, ctx.from, request, String(ctx.update.update_id), actions);
    if (reply !== null) await ctx.reply(reply);
    await next();
  });
}
