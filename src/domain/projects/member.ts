import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** `member` — исполнитель. */
export const MEMBER_ROLE = 'member';

/** `lead` — руководитель. */
export const LEAD_ROLE = 'lead';

/** Роли MVP. Третьей, в том числе «только просмотр», нет. */
export const PROJECT_ROLES = [MEMBER_ROLE, LEAD_ROLE] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Участник проекта: пользователь в проекте с одной из двух ролей. */
export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function projectRole(value: string): ProjectRole {
  if (value === MEMBER_ROLE || value === LEAD_ROLE) return value;
  throw new DomainError(DOMAIN_ERROR.PROJECT_ROLE, 'Роли две: member и lead');
}

/**
 * Кого добавили в проект, тот ведёт задачи.
 * Исполнитель и руководитель — оба. Роль это не отменяет.
 */
export function leadsTasks(role: ProjectRole): true {
  switch (role) {
    case MEMBER_ROLE:
    case LEAD_ROLE:
      return true;
    default: {
      const unreachable: never = role;
      throw new DomainError(DOMAIN_ERROR.PROJECT_ROLE, unreachable);
    }
  }
}

/** Поля участника при добавлении. Топик исполнителя задаёт отдельный акт, не эта функция. */
export function defineProjectMember(input: {
  id: string;
  projectId: string;
  userId: string;
  role: string;
}): ProjectMember {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_MEMBER_ID_BLANK, 'У участника есть id');
  }
  if (blank(input.projectId)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_MEMBER_PROJECT_BLANK, 'Участник принадлежит проекту');
  }
  if (blank(input.userId)) {
    throw new DomainError(DOMAIN_ERROR.PROJECT_MEMBER_USER_BLANK, 'Участник — пользователь');
  }
  const role = projectRole(input.role);
  return {
    id: input.id,
    projectId: input.projectId,
    userId: input.userId,
    role,
  };
}
