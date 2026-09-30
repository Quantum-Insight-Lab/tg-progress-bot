import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { projectCalendarDate } from '../shared/project-time.ts';
import { supergroupId } from './chat.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import { defineProjectMember, type ProjectRole } from './member.ts';
import { defineProject } from './project.ts';
import type { User } from './user.ts';

/** Корень в событии `project.settings_changed`. */
export const SETTINGS_ACTOR_ROLE = 'root';

const PROJECT_SUBJECT = 'Project';

export interface StoredProject {
  id: string;
  name: string;
  description: string;
  timezone: string;
  chatId: string | null;
  createdAt: string;
}

export interface SettingsMember {
  id: string;
  userId: string;
  name: string;
  role: ProjectRole;
}

export interface KnownChat {
  id: string;
  telegramChatId: string;
}

/** Порт настроек проекта внутри уже открытой транзакции. */
export interface SettingsStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<StoredProject[]>;
  findProject(projectId: string): Promise<StoredProject | null>;
  members(projectId: string): Promise<SettingsMember[]>;
  membersNamed(projectId: string, name: string): Promise<SettingsMember[]>;
  findChatByTelegramId(telegramChatId: string): Promise<KnownChat | null>;
  chatTelegramId(chatId: string): Promise<string | null>;
  saveName(projectId: string, name: string): Promise<void>;
  saveDescription(projectId: string, description: string): Promise<void>;
  saveTimezone(projectId: string, timezone: string): Promise<void>;
  saveChat(projectId: string, chatId: string): Promise<void>;
  saveRole(memberId: string, role: ProjectRole): Promise<void>;
}

export interface SettingsCommand {
  actor: User | null;
  chat: string;
  projectName: string;
}

export type SettingUpdate =
  | { field: 'name'; value: string }
  | { field: 'description'; value: string }
  | { field: 'timezone'; value: string }
  | { field: 'chat'; telegramChatId: string }
  | { field: 'member_role'; memberName: string; role: string };

export interface ChangeSetting extends SettingsCommand {
  update: SettingUpdate;
  idempotencyKey: string;
}

export interface SettingsMemberView {
  name: string;
  role: ProjectRole;
}

/** Экран админки: что сейчас записано у проекта. */
export interface SettingsView {
  name: string;
  description: string;
  timezone: string;
  telegramChatId: string | null;
  members: SettingsMemberView[];
}

/** Порт для адаптера Telegram. */
export interface ProjectSettings {
  open(input: { telegramUserId: string; projectName: string; chat: string }): Promise<SettingsView>;
  change(input: {
    telegramUserId: string;
    projectName: string;
    chat: string;
    update: SettingUpdate;
    idempotencyKey: string;
  }): Promise<SettingsView>;
}

/** Факт смены роли: пользователь и новая роль в одном поле `value`. */
export function memberRoleValue(userId: string, role: ProjectRole): string {
  return `${userId}:${role}`;
}

async function requireRoot(store: SettingsStore, actor: User | null, chat: string): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_CHAT, 'настройки меняются в личке');
  }
  if (actor === null || !actor.isRoot) {
    const member = actor !== null && (await store.hasMembership(actor.id));
    if (!member) throw new DomainError(DOMAIN_ERROR.SETTINGS_ACCESS, 'нет доступа');
    throw new DomainError(DOMAIN_ERROR.SETTINGS_ACTOR, 'настройки меняет корень');
  }
  return actor;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.SETTINGS_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

async function oneProject(store: SettingsStore, projectName: string): Promise<StoredProject> {
  const name = projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.SETTINGS_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0 ? DOMAIN_ERROR.SETTINGS_PROJECT_MISSING : DOMAIN_ERROR.SETTINGS_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.SETTINGS_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function viewOf(store: SettingsStore, projectId: string): Promise<SettingsView> {
  const project = await store.findProject(projectId);
  if (project === null) throw new DomainError(DOMAIN_ERROR.SETTINGS_PROJECT_MISSING, 'проект не найден');
  const telegramChatId = project.chatId === null ? null : await store.chatTelegramId(project.chatId);
  const members = await store.members(project.id);
  return {
    name: project.name,
    description: project.description,
    timezone: project.timezone,
    telegramChatId,
    members: members.map((member) => ({ name: member.name, role: member.role })),
  };
}

async function apply(store: SettingsStore, clock: Clock, project: StoredProject, update: SettingUpdate): Promise<string> {
  switch (update.field) {
    case 'name': {
      // Ссылка на репозиторий этим актом не пишется: в проверку имени она не входит.
      const next = defineProject({ ...project, repositoryId: null, name: update.value.trim() });
      await store.saveName(project.id, next.name);
      return next.name;
    }
    case 'description': {
      const description = update.value.trim();
      await store.saveDescription(project.id, description);
      return description;
    }
    case 'timezone': {
      const next = defineProject({ ...project, repositoryId: null, timezone: update.value.trim() });
      projectCalendarDate(clock.now(), next.timezone);
      await store.saveTimezone(project.id, next.timezone);
      return next.timezone;
    }
    case 'chat': {
      const telegramChatId = supergroupId(update.telegramChatId);
      const chat = await store.findChatByTelegramId(telegramChatId);
      if (chat === null) throw new DomainError(DOMAIN_ERROR.SETTINGS_CHAT_UNKNOWN, 'супергруппа боту неизвестна');
      await store.saveChat(project.id, chat.id);
      return chat.id;
    }
    case 'member_role': {
      const memberName = update.memberName.trim();
      const named = await store.membersNamed(project.id, memberName);
      if (named.length === 0) throw new DomainError(DOMAIN_ERROR.SETTINGS_MEMBER_ABSENT, 'в проекте этого человека нет');
      if (named.length !== 1) throw new DomainError(DOMAIN_ERROR.SETTINGS_MEMBER_AMBIGUOUS, 'имя участника не одно');
      const member = named[0];
      if (member === undefined) throw new DomainError(DOMAIN_ERROR.SETTINGS_MEMBER_ABSENT, 'в проекте этого человека нет');
      const next = defineProjectMember({
        id: member.id,
        projectId: project.id,
        userId: member.userId,
        role: update.role.trim(),
      });
      await store.saveRole(member.id, next.role);
      return memberRoleValue(next.userId, next.role);
    }
    default: {
      const unreachable: never = update;
      throw new DomainError(DOMAIN_ERROR.SETTINGS_PROJECT_MISSING, unreachable);
    }
  }
}

/** Экран настроек проекта. Меняет их только корень и только в личке. */
export async function showProjectSettings(store: SettingsStore, input: SettingsCommand): Promise<SettingsView> {
  await requireRoot(store, input.actor, input.chat);
  const project = await oneProject(store, input.projectName);
  return viewOf(store, project.id);
}

/**
 * Меняет одно поле проекта и пишет `project.settings_changed`.
 * Смена таймзоны не трогает уже отправленный канвас: события канваса здесь нет.
 * Новые сутки и новый застой читают записанную таймзону.
 * Повтор ключа откатывает запись.
 */
export async function changeProjectSetting(
  store: SettingsStore,
  journal: EventJournal,
  clock: Clock,
  input: ChangeSetting,
): Promise<SettingsView> {
  const actor = await requireRoot(store, input.actor, input.chat);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const project = await oneProject(store, input.projectName);
  const value = await apply(store, clock, project, input.update);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_SETTINGS_CHANGED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      project_id: project.id,
      field: input.update.field,
      value,
    },
    actor: { id: actor.id, role: SETTINGS_ACTOR_ROLE },
    subject: { entity: PROJECT_SUBJECT, id: project.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.SETTINGS_DUPLICATE, 'project.settings_changed уже записан');
  }
  return viewOf(store, project.id);
}
