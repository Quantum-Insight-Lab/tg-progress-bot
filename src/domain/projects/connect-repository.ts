import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import { LEAD_ROLE, type ProjectRole } from './member.ts';
import { defineRepositoryLink } from './project.ts';
import type { User } from './user.ts';

/** В событии репозиторий подключает руководитель. */
export const PROJECT_REPOSITORY_ACTOR_ROLE = LEAD_ROLE;

const PROJECT_SUBJECT = 'Project';

export interface KnownRepository {
  id: string;
  owner: string;
  name: string;
}

/** Проект и подключённый репозиторий. Пустая ссылка — репозиторий не подключён. */
export interface ProjectLink {
  id: string;
  name: string;
  repository: KnownRepository | null;
}

/** Порт ссылки `projects.repository_id` внутри уже открытой транзакции. */
export interface ProjectRepositoryStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<ProjectLink[]>;
  findProject(projectId: string): Promise<ProjectLink | null>;
  roleOnProject(projectId: string, userId: string): Promise<ProjectRole | null>;
  findRepository(repositoryId: string): Promise<KnownRepository | null>;
  lockProject(projectId: string): Promise<void>;
  setRepository(projectId: string, repositoryId: string): Promise<void>;
}

export interface RepositoryCommand {
  actor: User | null;
  chat: string;
}

export interface OpenRepositoryStep extends RepositoryCommand {
  projectName: string;
}

export interface OpenRepositoryById extends RepositoryCommand {
  projectId: string;
}

export interface ConnectProjectRepository extends OpenRepositoryById {
  repositoryId: string;
  idempotencyKey: string;
}

export interface SkipProjectRepository extends OpenRepositoryById {
  idempotencyKey: string;
}

export interface ConnectedRepository {
  status: 'connected' | 'unchanged';
  projectId: string;
  repository: KnownRepository;
}

export interface SkippedRepository {
  status: 'skipped';
  projectId: string;
  repository: null;
}

export interface KeptRepository {
  status: 'kept';
  projectId: string;
  repository: KnownRepository;
}

export type SkipResult = SkippedRepository | KeptRepository;

/** Порт для адаптера Telegram. Часы и транзакция — у реализации. */
export interface ProjectRepositoryActions {
  open(input: { telegramUserId: string; projectName: string; chat: string }): Promise<ProjectLink>;
  openById(input: { telegramUserId: string; projectId: string; chat: string }): Promise<ProjectLink>;
  connect(input: {
    telegramUserId: string;
    projectId: string;
    repositoryId: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<ConnectedRepository>;
  skip(input: { telegramUserId: string; projectId: string; chat: string; idempotencyKey: string }): Promise<SkipResult>;
}

/**
 * Зеркало и доля живут на репозитории.
 * У проекта только id: два проекта с одним id видят одну долю.
 */
export function projectRepositoryShareKey(repositoryId: string | null): string | null {
  return defineRepositoryLink(repositoryId);
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  return key;
}

async function authorize(
  store: ProjectRepositoryStore,
  actor: User | null,
  chat: string,
  projectId: string,
): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_CHAT, 'репозиторий подключают в личке');
  }
  if (actor === null) throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ACCESS, 'нет доступа');
  if (actor.isRoot) return actor;
  const participates = await store.hasMembership(actor.id);
  if (!participates) throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ACCESS, 'нет доступа');
  const role = await store.roleOnProject(projectId, actor.id);
  if (role !== LEAD_ROLE) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ACTOR, 'репозиторий подключает руководитель');
  }
  return actor;
}

async function oneProject(store: ProjectRepositoryStore, projectName: string): Promise<ProjectLink> {
  const name = projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0
        ? DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_MISSING
        : DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function requireProject(store: ProjectRepositoryStore, projectId: string): Promise<ProjectLink> {
  const project = await store.findProject(projectId);
  if (project === null) throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_PROJECT_MISSING, 'проект не найден');
  return project;
}

async function locked(store: ProjectRepositoryStore, projectId: string): Promise<ProjectLink> {
  await store.lockProject(projectId);
  return requireProject(store, projectId);
}

/** Экран шага: какой репозиторий уже подключён. Список установки собирает адаптер. */
export async function describeProjectRepository(store: ProjectRepositoryStore, input: OpenRepositoryStep): Promise<ProjectLink> {
  const project = await oneProject(store, input.projectName);
  await authorize(store, input.actor, input.chat, project.id);
  return project;
}

/** Тот же экран по id проекта: так шаг открывается сразу после привязки группы. */
export async function describeProjectRepositoryById(
  store: ProjectRepositoryStore,
  input: OpenRepositoryById,
): Promise<ProjectLink> {
  const project = await requireProject(store, input.projectId);
  await authorize(store, input.actor, input.chat, project.id);
  return project;
}

/**
 * Подключает один репозиторий установки и публикует `project.repository_connected`.
 * Второй, другой, не записывается: у проекта не больше одной ссылки.
 * Тот же id второй раз состояние не меняет и второго события не пишет.
 * Репозиторий должен уже быть в зеркале установки.
 */
export async function connectProjectRepository(
  store: ProjectRepositoryStore,
  journal: EventJournal,
  clock: Clock,
  input: ConnectProjectRepository,
): Promise<ConnectedRepository> {
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  const repositoryId = defineRepositoryLink(input.repositoryId);
  if (repositoryId === null) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ID, 'id репозитория — id GitHub');
  }
  const project = await requireProject(store, input.projectId);
  const actor = await authorize(store, input.actor, input.chat, project.id);
  const known = await store.findRepository(repositoryId);
  if (known === null) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_UNKNOWN, 'этого репозитория нет в установке');
  }
  const fresh = await locked(store, project.id);
  if (fresh.repository !== null) {
    if (fresh.repository.id === known.id) {
      return { status: 'unchanged', projectId: fresh.id, repository: fresh.repository };
    }
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ALREADY, 'к проекту подключён один репозиторий');
  }
  await store.setRepository(fresh.id, known.id);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_REPOSITORY_CONNECTED,
    source: 'telegram',
    idempotencyKey,
    payload: { project_id: fresh.id, repository_id: known.id },
    actor: { id: actor.id, role: PROJECT_REPOSITORY_ACTOR_ROLE },
    subject: { entity: PROJECT_SUBJECT, id: fresh.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_DUPLICATE, 'project.repository_connected уже записан');
  }
  return { status: 'connected', projectId: fresh.id, repository: known };
}

/**
 * Шаг можно пропустить. Пустая ссылка остаётся пустой, уже подключённый репозиторий не стирается.
 * События подключения при пропуске нет.
 */
export async function skipProjectRepository(
  store: ProjectRepositoryStore,
  input: SkipProjectRepository,
): Promise<SkipResult> {
  idempotencyKeyOf(input.idempotencyKey);
  const project = await requireProject(store, input.projectId);
  await authorize(store, input.actor, input.chat, project.id);
  const fresh = await locked(store, project.id);
  if (fresh.repository !== null) {
    return { status: 'kept', projectId: fresh.id, repository: fresh.repository };
  }
  return { status: 'skipped', projectId: fresh.id, repository: null };
}
