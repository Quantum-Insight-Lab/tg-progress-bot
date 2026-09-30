import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Проект — единица людей и учёта. Репозиторий подключается к нему отдельно. */
export interface Project {
  id: string;
  name: string;
  description: string;
  timezone: string;
  /** Общая супергруппа. Пусто, пока группа не привязана. */
  chatId: string | null;
  /** Репозиторий установки. Пусто — не подключён. */
  repositoryId: string | null;
  createdAt: string;
}

/**
 * Своё у проекта: не лежит в строке `projects` и не делится с другим проектом (L-5).
 * Учёт задач, ролей и канвасов идёт по id проекта.
 */
export const PROJECT_OWN = ['tasks', 'roles', 'canvases'] as const;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/** Пусто — репозиторий не подключён. Непустое значение — id GitHub. */
export function defineRepositoryLink(value: string | null): string | null {
  if (value === null) return null;
  const id = value.trim();
  if (id.length === 0) return null;
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_REPOSITORY_ID, 'id репозитория — id GitHub');
  }
  return id;
}

/** Поля проекта. Задачи, роли и канвасы в строку не входят. */
export function defineProject(input: Project): Project {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_ID_BLANK, 'У проекта есть id');
  }
  if (blank(input.name)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_NAME_BLANK, 'У проекта есть имя');
  }
  if (blank(input.timezone)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_TIMEZONE_BLANK, 'У проекта есть таймзона');
  }
  if (blank(input.createdAt)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_CREATED_AT_BLANK, 'У проекта есть момент создания');
  }
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    timezone: input.timezone,
    chatId: input.chatId,
    repositoryId: defineRepositoryLink(input.repositoryId),
    createdAt: input.createdAt,
  };
}
