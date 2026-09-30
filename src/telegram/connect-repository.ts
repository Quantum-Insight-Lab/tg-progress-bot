import { InlineKeyboard, type Bot } from 'grammy';
import type { InstallationRepositories, Repository } from '../domain/github/repository.ts';
import type {
  ChangedRepository,
  ConnectedRepository,
  ProjectLink,
  ProjectRepositoryActions,
  RepositoryStepView,
  SkipResult,
} from '../domain/projects/connect-repository.ts';
import { PRIVATE_CHAT } from '../domain/projects/create-project.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';
import { REPOSITORIES_APP, REPOSITORIES_UNAVAILABLE } from './installation-repositories.ts';

/** Заголовок отдельного шага онбординга. */
export const PROJECT_REPOSITORY_HEADING = 'Репозиторий';

export const PROJECT_REPOSITORY_STEP = 'Репозиторий — отдельный шаг. Его можно пропустить. Подключает руководитель.';

export const PROJECT_REPOSITORY_EMPTY = 'Установка GitHub App не дала репозиториев. Шаг можно пропустить.';

export const PROJECT_REPOSITORY_SKIP_LABEL = 'Пропустить';

export const PROJECT_REPOSITORY_SKIPPED = 'Шаг пропущен.';

export const PROJECT_REPOSITORY_ACTOR = 'Репозиторий подключает руководитель.';

export const PROJECT_REPOSITORY_ALREADY = 'К проекту подключён один репозиторий.';

export const PROJECT_REPOSITORY_UNKNOWN = 'Этого репозитория нет в установке GitHub App.';

export const PROJECT_REPOSITORY_NO_PROJECT = 'Такого проекта нет.';

export const PROJECT_REPOSITORY_AMBIGUOUS = 'Уточните проект: имя совпало у нескольких.';

export const PROJECT_REPOSITORY_ACCESS = 'Нет доступа.';

export const PROJECT_REPOSITORY_ROOT_CHANGES = 'Сменяет только корень.';

export const PROJECT_REPOSITORY_CHANGE_ACTOR_REPLY = 'Репозиторий меняет только корень.';

export const PROJECT_REPOSITORY_NOT_CONNECTED = 'Репозиторий ещё не подключён.';

const BUTTON_TEXT_LIMIT = 64;

const CALLBACK_DATA_LIMIT = 64;

interface TelegramAccount {
  id: number;
  is_bot: boolean;
}

export interface ScreenReply {
  text: string;
  markup?: InlineKeyboard;
}

export function projectRepositoryConnectedReply(owner: string, name: string): string {
  return `Репозиторий подключён: ${owner}/${name}.`;
}

export function projectRepositoryChangedReply(owner: string, name: string): string {
  return `Репозиторий сменён: ${owner}/${name}.`;
}

export function projectRepositoryCurrent(owner: string, name: string): string {
  return `Подключён: ${owner}/${name}.`;
}

/** «Репозиторий» и имя проекта. Чужой текст шагом не считается. */
export function parseProjectRepositoryMessage(text: string): { projectName: string } | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length !== 2) return null;
  if (lines[0]?.trim() !== PROJECT_REPOSITORY_HEADING) return null;
  const projectName = lines[1]?.trim() ?? '';
  if (projectName.length === 0) return null;
  return { projectName };
}

export function connectRepositoryData(projectId: string, repositoryId: string): string | null {
  const data = `rc:${projectId}:${repositoryId}`;
  if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) return null;
  return data;
}

export function skipRepositoryData(projectId: string): string {
  return `rs:${projectId}`;
}

export function changeRepositoryData(projectId: string, repositoryId: string): string | null {
  const data = `rx:${projectId}:${repositoryId}`;
  if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) return null;
  return data;
}

export function parseConnectRepositoryData(data: string): { projectId: string; repositoryId: string } | null {
  const match = /^rc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]*)$/.exec(data);
  const projectId = match?.[1];
  const repositoryId = match?.[2];
  if (projectId === undefined || repositoryId === undefined) return null;
  return { projectId, repositoryId };
}

export function parseSkipRepositoryData(data: string): { projectId: string } | null {
  const match = /^rs:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(data);
  const projectId = match?.[1];
  if (projectId === undefined) return null;
  return { projectId };
}

export function parseChangeRepositoryData(data: string): { projectId: string; repositoryId: string } | null {
  const match = /^rx:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]*)$/.exec(data);
  const projectId = match?.[1];
  const repositoryId = match?.[2];
  if (projectId === undefined || repositoryId === undefined) return null;
  return { projectId, repositoryId };
}

function buttonLabel(name: string): string {
  return name.length > BUTTON_TEXT_LIMIT ? name.slice(0, BUTTON_TEXT_LIMIT) : name;
}

/** Выбор из списка установки и кнопка пропуска. Уже подключённый репозиторий кнопок не получает. */
export function projectRepositoryKeyboard(projectId: string, repositories: readonly Repository[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const repository of repositories) {
    const data = connectRepositoryData(projectId, repository.id);
    if (data === null) continue;
    keyboard.text(buttonLabel(`${repository.owner}/${repository.name}`), data).row();
  }
  keyboard.text(PROJECT_REPOSITORY_SKIP_LABEL, skipRepositoryData(projectId));
  return keyboard;
}

/** Выбор другого репозитория установки. Текущий и пропуск в смену не входят. */
export function projectRepositoryChangeKeyboard(
  projectId: string,
  repositories: readonly Repository[],
  currentId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const repository of repositories) {
    if (repository.id === currentId) continue;
    const data = changeRepositoryData(projectId, repository.id);
    if (data === null) continue;
    keyboard.text(buttonLabel(`${repository.owner}/${repository.name}`), data).row();
  }
  return keyboard;
}

function stepText(project: ProjectLink, empty: boolean): string {
  const lines = [PROJECT_REPOSITORY_HEADING, project.name, ''];
  if (project.repository !== null) {
    lines.push(projectRepositoryCurrent(project.repository.owner, project.repository.name));
    return lines.join('\n');
  }
  lines.push(empty ? PROJECT_REPOSITORY_EMPTY : PROJECT_REPOSITORY_STEP);
  return lines.join('\n');
}

function changeStepText(project: ProjectLink): string {
  if (project.repository === null) return stepText(project, false);
  return [
    PROJECT_REPOSITORY_HEADING,
    project.name,
    '',
    projectRepositoryCurrent(project.repository.owner, project.repository.name),
    PROJECT_REPOSITORY_ROOT_CHANGES,
  ].join('\n');
}

function hasChoices(keyboard: InlineKeyboard): boolean {
  return keyboard.inline_keyboard.some((row) => row.length > 0);
}

function replyOf(error: unknown): string | null {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case DOMAIN_ERROR.PROJECT_REPOSITORY_CHAT:
    case DOMAIN_ERROR.PROJECT_REPOSITORY_DUPLICATE:
    case DOMAIN_ERROR.PROJECT_REPOSITORY_IDEMPOTENCY_KEY:
      return null;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_ACTOR:
      return PROJECT_REPOSITORY_ACTOR;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_ACCESS:
      return PROJECT_REPOSITORY_ACCESS;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_MISSING:
      return PROJECT_REPOSITORY_NO_PROJECT;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_AMBIGUOUS:
      return PROJECT_REPOSITORY_AMBIGUOUS;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_UNKNOWN:
    case DOMAIN_ERROR.PROJECT_REPOSITORY_ID:
      return PROJECT_REPOSITORY_UNKNOWN;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_ALREADY:
      return PROJECT_REPOSITORY_ALREADY;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_CHANGE_ACTOR:
      return PROJECT_REPOSITORY_CHANGE_ACTOR_REPLY;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_NOT_CONNECTED:
      return PROJECT_REPOSITORY_NOT_CONNECTED;
    case DOMAIN_ERROR.PROJECT_REPOSITORY_CHANGE_DUPLICATE:
      return null;
    default:
      throw error;
  }
}

function connectedText(result: ConnectedRepository): string {
  if (result.status === 'unchanged') return projectRepositoryCurrent(result.repository.owner, result.repository.name);
  return projectRepositoryConnectedReply(result.repository.owner, result.repository.name);
}

function changedText(result: ChangedRepository): string {
  if (result.status === 'unchanged') return projectRepositoryCurrent(result.repository.owner, result.repository.name);
  return projectRepositoryChangedReply(result.repository.owner, result.repository.name);
}

function skippedText(result: SkipResult): string {
  if (result.status === 'kept') return projectRepositoryCurrent(result.repository.owner, result.repository.name);
  return PROJECT_REPOSITORY_SKIPPED;
}

async function installationList(
  installation: InstallationRepositories,
  telegramUserId: string,
  chat: string,
  idempotencyKey: string,
): Promise<{ repositories: Repository[]; failure: string | null }> {
  try {
    const repositories = await installation.show({ telegramUserId, chat, idempotencyKey });
    return { repositories: [...repositories], failure: null };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    if (error.code === DOMAIN_ERROR.REPOSITORY_APP) return { repositories: [], failure: REPOSITORIES_APP };
    if (error.code === DOMAIN_ERROR.REPOSITORY_UNAVAILABLE) return { repositories: [], failure: REPOSITORIES_UNAVAILABLE };
    throw error;
  }
}

async function changeScreen(
  project: RepositoryStepView,
  telegramUserId: string,
  chat: string,
  idempotencyKey: string,
  installation: InstallationRepositories,
): Promise<ScreenReply | null> {
  if (project.repository === null || !project.canChange) return null;
  const listed = await installationList(installation, telegramUserId, chat, idempotencyKey);
  const text = changeStepText(project);
  if (listed.failure !== null) return { text: [text, '', listed.failure].join('\n') };
  const markup = projectRepositoryChangeKeyboard(project.id, listed.repositories, project.repository.id);
  if (!hasChoices(markup)) return { text };
  return { text, markup };
}

/** Шаг в личке: список установки или уже подключённый репозиторий. */
export async function openProjectRepositoryStep(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  projectName: string,
  actions: ProjectRepositoryActions,
  installation: InstallationRepositories,
): Promise<ScreenReply | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  try {
    const project = await actions.open({ telegramUserId: String(from.id), projectName, chat: chatType });
    if (project.repository !== null) {
      const change = await changeScreen(project, String(from.id), chatType, idempotencyKey, installation);
      if (change !== null) return change;
      return { text: stepText(project, false) };
    }
    const listed = await installationList(installation, String(from.id), chatType, idempotencyKey);
    if (listed.failure !== null) {
      return {
        text: [PROJECT_REPOSITORY_HEADING, project.name, '', listed.failure].join('\n'),
        markup: projectRepositoryKeyboard(project.id, []),
      };
    }
    return {
      text: stepText(project, listed.repositories.length === 0),
      markup: projectRepositoryKeyboard(project.id, listed.repositories),
    };
  } catch (error) {
    const text = replyOf(error);
    if (text === null) return null;
    return { text };
  }
}

/** После привязки супергруппы — тот же шаг для этого проекта. */
export async function deliverProjectRepositoryStep(
  from: TelegramAccount,
  projectId: string,
  idempotencyKey: string,
  actions: ProjectRepositoryActions,
  installation: InstallationRepositories,
  send: (text: string, markup?: InlineKeyboard) => Promise<unknown>,
): Promise<void> {
  const screen = await openProjectRepositoryById(from, projectId, idempotencyKey, actions, installation);
  if (screen === null) return;
  await send(screen.text, screen.markup);
}

async function openProjectRepositoryById(
  from: TelegramAccount,
  projectId: string,
  idempotencyKey: string,
  actions: ProjectRepositoryActions,
  installation: InstallationRepositories,
): Promise<ScreenReply | null> {
  if (from.is_bot) return null;
  try {
    const project = await actions.openById({
      telegramUserId: String(from.id),
      projectId,
      chat: PRIVATE_CHAT,
    });
    if (project.repository !== null) {
      const change = await changeScreen(project, String(from.id), PRIVATE_CHAT, idempotencyKey, installation);
      if (change !== null) return change;
      return { text: stepText(project, false) };
    }
    const listed = await installationList(installation, String(from.id), PRIVATE_CHAT, idempotencyKey);
    if (listed.failure !== null) {
      return {
        text: [PROJECT_REPOSITORY_HEADING, project.name, '', listed.failure].join('\n'),
        markup: projectRepositoryKeyboard(project.id, []),
      };
    }
    return {
      text: stepText(project, listed.repositories.length === 0),
      markup: projectRepositoryKeyboard(project.id, listed.repositories),
    };
  } catch (error) {
    const text = replyOf(error);
    if (text === null) return null;
    return { text };
  }
}

export async function replyToConnectRepository(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  projectId: string,
  repositoryId: string,
  actions: ProjectRepositoryActions,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  try {
    const result = await actions.connect({
      telegramUserId: String(from.id),
      projectId,
      repositoryId,
      chat: chatType,
      idempotencyKey,
    });
    return connectedText(result);
  } catch (error) {
    return replyOf(error);
  }
}

export async function replyToChangeRepository(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  projectId: string,
  repositoryId: string,
  actions: ProjectRepositoryActions,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  try {
    const result = await actions.change({
      telegramUserId: String(from.id),
      projectId,
      repositoryId,
      chat: chatType,
      idempotencyKey,
    });
    return changedText(result);
  } catch (error) {
    return replyOf(error);
  }
}

export async function replyToSkipRepository(
  chatType: string | undefined,
  from: TelegramAccount | undefined,
  idempotencyKey: string,
  projectId: string,
  actions: ProjectRepositoryActions,
): Promise<string | null> {
  if (chatType !== PRIVATE_CHAT || from === undefined || from.is_bot) return null;
  try {
    const result = await actions.skip({
      telegramUserId: String(from.id),
      projectId,
      chat: chatType,
      idempotencyKey,
    });
    return skippedText(result);
  } catch (error) {
    return replyOf(error);
  }
}

/** Сообщение «Репозиторий» и кнопки списка. Роль проверяет домен. */
export function attachProjectRepository(
  bot: Bot,
  actions: ProjectRepositoryActions,
  installation: InstallationRepositories,
): void {
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text === undefined) {
      await next();
      return;
    }
    const parsed = parseProjectRepositoryMessage(text);
    if (parsed === null) {
      await next();
      return;
    }
    const screen = await openProjectRepositoryStep(
      ctx.chat?.type,
      ctx.from,
      String(ctx.update.update_id),
      parsed.projectName,
      actions,
      installation,
    );
    if (screen !== null) {
      if (screen.markup === undefined) await ctx.reply(screen.text);
      else await ctx.reply(screen.text, { reply_markup: screen.markup });
    }
    await next();
  });

  bot.callbackQuery(/^rc:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseConnectRepositoryData(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || from.is_bot) return;
    const reply = await replyToConnectRepository(
      ctx.chat?.type,
      from,
      String(ctx.update.update_id),
      parsed.projectId,
      parsed.repositoryId,
      actions,
    );
    if (reply !== null) await ctx.reply(reply);
  });

  bot.callbackQuery(/^rx:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseChangeRepositoryData(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || from.is_bot) return;
    const reply = await replyToChangeRepository(
      ctx.chat?.type,
      from,
      String(ctx.update.update_id),
      parsed.projectId,
      parsed.repositoryId,
      actions,
    );
    if (reply !== null) await ctx.reply(reply);
  });

  bot.callbackQuery(/^rs:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parsed = parseSkipRepositoryData(ctx.callbackQuery.data);
    const from = ctx.from;
    if (parsed === null || from.is_bot) return;
    const reply = await replyToSkipRepository(ctx.chat?.type, from, String(ctx.update.update_id), parsed.projectId, actions);
    if (reply !== null) await ctx.reply(reply);
  });
}
