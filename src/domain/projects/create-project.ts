import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineProject, type Project } from './project.ts';
import type { User } from './user.ts';

/** В проекте, который заводит корень, он `lead`. */
export const PROJECT_CREATOR_ROLE = 'lead';

/** Личка — единственный вход, где заводят проект. */
export const PRIVATE_CHAT = 'private';

/** Порт таблицы `projects` внутри уже открытой транзакции. */
export interface ProjectStore {
  insert(project: Project): Promise<void>;
}

/** Команда «Новый проект»: три поля и кто их прислал. `creator` пуст, если аккаунта нет. */
export interface NewProject {
  id: string;
  name: string;
  description: string;
  timezone: string;
  creator: User | null;
  chat: string;
  idempotencyKey: string;
}

export interface CreatedProject {
  project: Project;
  creatorId: string;
  creatorRole: typeof PROJECT_CREATOR_ROLE;
}

/** Порт для адаптера Telegram. Часы, id и транзакция — у реализации. */
export interface ProjectCreation {
  create(input: ProjectDraft): Promise<CreatedProject>;
}

export interface ProjectDraft {
  telegramUserId: string;
  name: string;
  description: string;
  timezone: string;
  chat: string;
  idempotencyKey: string;
}

/**
 * «Новый проект» в личке. Заводит корень; в этом проекте он `lead`.
 * Повтор того же ключа не пишет второй проект.
 */
export async function createProject(
  store: ProjectStore,
  journal: EventJournal,
  clock: Clock,
  input: NewProject,
): Promise<CreatedProject> {
  if (input.chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_CHAT, 'проект заводится в личке');
  }
  const creator = input.creator;
  if (creator === null || !creator.isRoot) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_CREATOR, 'проект заводит корень');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const now = clock.now();
  const project = defineProject({
    id: input.id,
    name: input.name.trim(),
    description: input.description.trim(),
    timezone: input.timezone.trim(),
    chatId: null,
    repositoryId: null,
    createdAt: now.toISOString(),
  });
  await store.insert(project);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_CREATED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      project_id: project.id,
      name: project.name,
      description: project.description,
      timezone: project.timezone,
      created_by: creator.id,
    },
    actor: { id: creator.id, role: PROJECT_CREATOR_ROLE },
    subject: { entity: 'Project', id: project.id },
    occurredAt: now,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.PROJECT_DUPLICATE, 'project.created уже записан');
  }
  return { project, creatorId: creator.id, creatorRole: PROJECT_CREATOR_ROLE };
}
