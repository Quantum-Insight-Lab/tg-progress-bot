import type { Bot } from 'grammy';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import type { ProjectSettings, SettingsView, SettingUpdate } from '../domain/projects/settings.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { noteCommandRejection } from './rejection.ts';

/** Строка админки проекта в личке корня. */
export const SETTINGS_HEADING = 'Настройки';

export const SETTINGS_ROOT_ONLY = 'Настройки меняет корень.';

export const SETTINGS_ACCESS = 'Нет доступа.';

export const SETTINGS_NO_PROJECT = 'Такого проекта нет.';

export const SETTINGS_AMBIGUOUS = 'Уточните проект: имя совпало у нескольких.';

export const SETTINGS_NEED_NAME = 'Нужно имя.';

export const SETTINGS_NEED_ZONE = 'Нужна таймзона проекта.';

export const SETTINGS_BAD_ZONE = 'Таймзона не распознана.';

export const SETTINGS_CHAT_UNKNOWN = 'Такой супергруппы бот ещё не знает.';

export const SETTINGS_NOT_SUPERGROUP = 'Нужна супергруппа, не топик.';

export const SETTINGS_MEMBER_ABSENT = 'В проекте этого человека нет.';

export const SETTINGS_MEMBER_AMBIGUOUS = 'Уточните человека: имя совпало у нескольких.';

export const SETTINGS_ROLE = 'Роли две: member и lead.';

export const SETTINGS_ROLE_SHAPE = 'Роль: имя человека, затем member или lead.';

export const SETTINGS_UNKNOWN_FIELD = 'Такого поля нет. Поля: имя, описание, таймзона, супергруппа, роль.';

export const SETTINGS_HINT = 'Четыре строки: «Настройки», имя проекта, поле, значение.';

export const SETTINGS_UNBOUND = 'не привязана';

const FIELD_LABEL = {
  имя: 'name',
  описание: 'description',
  таймзона: 'timezone',
  супергруппа: 'chat',
  роль: 'member_role',
} as const;

type FieldLabel = keyof typeof FIELD_LABEL;

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export type SettingsRequest =
  | { kind: 'show'; projectName: string }
  | { kind: 'change'; projectName: string; update: SettingUpdate }
  | { kind: 'hint' }
  | { kind: 'unknown-field' }
  | { kind: 'role-shape' };

function isFieldLabel(value: string): value is FieldLabel {
  return Object.prototype.hasOwnProperty.call(FIELD_LABEL, value);
}

/** «Настройки» и имя проекта, либо те же строки плюс поле и значение. Чужой текст командой не считается. */
export function parseSettingsMessage(text: string): SettingsRequest | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== SETTINGS_HEADING) return null;
  if (lines.length === 2) {
    const projectName = lines[1]?.trim() ?? '';
    if (projectName.length === 0) return null;
    return { kind: 'show', projectName };
  }
  if (lines.length !== 4) return { kind: 'hint' };
  const projectName = lines[1]?.trim() ?? '';
  if (projectName.length === 0) return { kind: 'hint' };
  const label = lines[2]?.trim() ?? '';
  if (!isFieldLabel(label)) return { kind: 'unknown-field' };
  const field = FIELD_LABEL[label];
  const raw = lines[3] ?? '';
  if (field === 'member_role') {
    const value = raw.trim();
    const cut = value.lastIndexOf(' ');
    if (cut <= 0) return { kind: 'role-shape' };
    const memberName = value.slice(0, cut).trim();
    const role = value.slice(cut + 1).trim();
    if (memberName.length === 0 || role.length === 0) return { kind: 'role-shape' };
    return { kind: 'change', projectName, update: { field, memberName, role } };
  }
  if (field === 'chat') return { kind: 'change', projectName, update: { field, telegramChatId: raw.trim() } };
  return { kind: 'change', projectName, update: { field, value: raw.trim() } };
}

/** Админка: текущие имя, описание, таймзона, супергруппа и роли. */
export function renderSettings(view: SettingsView): string {
  const supergroup = view.telegramChatId === null ? SETTINGS_UNBOUND : view.telegramChatId;
  return [
    SETTINGS_HEADING,
    view.name,
    '',
    `Имя: ${view.name}`,
    `Описание: ${view.description}`,
    `Таймзона проекта: ${view.timezone}`,
    `Супергруппа: ${supergroup}`,
    'Роли:',
    ...view.members.map((member) => `${member.name} — ${member.role}`),
  ].join('\n');
}

function replyOf(error: unknown): string | null {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.SETTINGS_DUPLICATE:
    case DOMAIN_ERROR.SETTINGS_CHAT:
      return null;
    case DOMAIN_ERROR.SETTINGS_ACCESS:
      return SETTINGS_ACCESS;
    case DOMAIN_ERROR.SETTINGS_ACTOR:
      return SETTINGS_ROOT_ONLY;
    case DOMAIN_ERROR.SETTINGS_PROJECT_MISSING:
      return SETTINGS_NO_PROJECT;
    case DOMAIN_ERROR.SETTINGS_PROJECT_AMBIGUOUS:
      return SETTINGS_AMBIGUOUS;
    case DOMAIN_ERROR.PROJECT_NAME_BLANK:
      return SETTINGS_NEED_NAME;
    case DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK:
      return SETTINGS_NEED_ZONE;
    case DOMAIN_ERROR.SETTINGS_TIMEZONE:
      return SETTINGS_BAD_ZONE;
    case DOMAIN_ERROR.SETTINGS_CHAT_UNKNOWN:
      return SETTINGS_CHAT_UNKNOWN;
    case DOMAIN_ERROR.CHAT_IS_TOPIC:
      return SETTINGS_NOT_SUPERGROUP;
    case DOMAIN_ERROR.SETTINGS_MEMBER_ABSENT:
      return SETTINGS_MEMBER_ABSENT;
    case DOMAIN_ERROR.SETTINGS_MEMBER_AMBIGUOUS:
      return SETTINGS_MEMBER_AMBIGUOUS;
    case DOMAIN_ERROR.PROJECT_ROLE:
      return SETTINGS_ROLE;
    default:
      throw error;
  }
}

/** Личка корня показывает и меняет настройки. Вне лички молчит. */
export async function replyToSettings(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  request: SettingsRequest,
  idempotencyKey: string,
  actions: ProjectSettings,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  if (request.kind === 'hint') return SETTINGS_HINT;
  if (request.kind === 'unknown-field') return SETTINGS_UNKNOWN_FIELD;
  if (request.kind === 'role-shape') return SETTINGS_ROLE_SHAPE;
  try {
    const view =
      request.kind === 'show'
        ? await actions.open({ telegramUserId: String(from.id), projectName: request.projectName, chat: chatType })
        : await actions.change({
            telegramUserId: String(from.id),
            projectName: request.projectName,
            chat: chatType,
            update: request.update,
            idempotencyKey,
          });
    return renderSettings(view);
  } catch (error) {
    await noteCommandRejection(error, idempotencyKey, String(from.id));
    return replyOf(error);
  }
}

/** «Настройки» на единственном экземпляре grammY. */
export function attachSettings(bot: Bot, actions: ProjectSettings): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const request = parseSettingsMessage(text);
    if (request === null) {
      await next();
      return;
    }
    const reply = await replyToSettings(ctx.chat?.type, ctx.from, request, String(ctx.update.update_id), actions);
    if (reply !== null) await ctx.reply(reply);
    await next();
  });
}
