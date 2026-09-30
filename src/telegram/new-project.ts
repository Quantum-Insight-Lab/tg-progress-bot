import type { Bot } from 'grammy';
import { PRIVATE_CHAT, type ProjectCreation, type ProjectDraft } from '../domain/projects/create-project.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import type { SupergroupReply } from './chat-binding.ts';
import { traceHandler, traceRefusal } from './update-log.ts';

/** Шаг онбординга: заголовок сообщения, затем имя, описание и таймзона. */
export const NEW_PROJECT_HEADING = 'Новый проект';

export const NEW_PROJECT_REFUSAL = 'Завести проект может корень.';

export const NEW_PROJECT_FIELDS = 'Нужны имя и таймзона.';

export function projectCreatedReply(name: string): string {
  return `Проект «${name}» заведён.`;
}

export interface NewProjectFields {
  name: string;
  description: string;
  timezone: string;
}

/**
 * «Новый проект» — четыре строки: заголовок, имя, описание, таймзона.
 * Описание может быть пустой строкой. Чужой текст командой не считается.
 */
export function parseNewProjectMessage(text: string): NewProjectFields | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length !== 4) return null;
  if (lines[0]?.trim() !== NEW_PROJECT_HEADING) return null;
  const name = lines[1];
  const description = lines[2];
  const timezone = lines[3];
  if (name === undefined || description === undefined || timezone === undefined) return null;
  return { name: name.trim(), description: description.trim(), timezone: timezone.trim() };
}

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

/**
 * Сообщение в личке заводит проект и возвращает ответ.
 * Вне лички молчит: проект там не создаётся.
 */
export async function replyToNewProject(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  fields: NewProjectFields,
  creation: ProjectCreation,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  const draft: ProjectDraft = {
    telegramUserId: String(from.id),
    name: fields.name,
    description: fields.description,
    timezone: fields.timezone,
    chat: chatType,
    idempotencyKey,
  };
  try {
    const created = await creation.create(draft);
    return projectCreatedReply(created.project.name);
  } catch (error) {
    traceRefusal(error);
    if (!(error instanceof DomainError)) throw error;
    if (error.code === DOMAIN_ERROR.PROJECT_DUPLICATE) return null;
    if (error.code === DOMAIN_ERROR.PROJECT_CREATOR) return NEW_PROJECT_REFUSAL;
    if (error.code === DOMAIN_ERROR.PROJECT_NAME_BLANK || error.code === DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK) {
      return NEW_PROJECT_FIELDS;
    }
    throw error;
  }
}

/** Сообщение «Новый проект» на единственном экземпляре grammY. После удачного заведения — следующий шаг онбординга. */
export function attachNewProject(
  bot: Bot,
  creation: ProjectCreation,
  afterCreated?: (reply: SupergroupReply) => Promise<void>,
): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const fields = parseNewProjectMessage(text);
    if (fields === null) {
      await next();
      return;
    }
    traceHandler('new-project');
    const chatType = ctx.chat?.type;
    const reply = await replyToNewProject(chatType, ctx.from, String(ctx.update.update_id), fields, creation);
    if (reply !== null) {
      await ctx.reply(reply);
      if (afterCreated !== undefined && reply === projectCreatedReply(fields.name)) {
        await afterCreated(async (followUp, markup) => {
          if (markup === undefined) await ctx.reply(followUp);
          else await ctx.reply(followUp, { reply_markup: markup });
        });
      }
    }
    await next();
  });
}
