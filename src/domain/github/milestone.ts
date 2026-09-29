import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { githubRepositoryId } from './repository.ts';

/** Milestone открыт. */
export const MILESTONE_STATE_OPEN = 'open';

/** Milestone закрыт. */
export const MILESTONE_STATE_CLOSED = 'closed';

/** Состояния milestone. Другого нет. */
export const MILESTONE_STATES = [MILESTONE_STATE_OPEN, MILESTONE_STATE_CLOSED] as const;

export type MilestoneState = (typeof MILESTONE_STATES)[number];

/**
 * Milestone зеркала (E-13): факт GitHub с названием и сроком.
 * Ключ — id. Природный ключ — репозиторий и номер, не проект и не задача.
 */
export interface Milestone {
  id: string;
  repositoryId: string;
  milestoneNumber: number;
  title: string;
  state: MilestoneState;
  /** Календарная дата `YYYY-MM-DD`. Пусто, если в GitHub срока нет. */
  dueOn: string | null;
}

const CALENDAR_DATE = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  for (const item of allowed) {
    if (item === value) return item;
  }
  return undefined;
}

function milestoneState(value: string): MilestoneState {
  const state = oneOf(value.trim(), MILESTONE_STATES);
  if (state !== undefined) return state;
  throw new DomainError(DOMAIN_ERROR.MILESTONE_STATE, 'Состояние milestone — open или closed');
}

/** Срок — календарная дата или пусто. Метка времени GitHub сворачивается в дату. */
export function milestoneDueOn(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const date = CALENDAR_DATE.exec(trimmed)?.[1];
  if (date === undefined || Number.isNaN(Date.parse(trimmed))) {
    throw new DomainError(DOMAIN_ERROR.MILESTONE_DUE_ON, 'Срок milestone — дата или пусто');
  }
  return date;
}

function milestoneNumberOf(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(DOMAIN_ERROR.MILESTONE_NUMBER, 'Номер milestone — положительное число GitHub');
  }
  return value;
}

/** Поля milestone без id. Проекта и задачи среди них нет. */
export function milestoneFields(input: {
  repositoryId: string;
  milestoneNumber: number;
  title: string;
  state: string;
  dueOn: string | null;
}): Omit<Milestone, 'id'> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DomainError(DOMAIN_ERROR.MILESTONE_TITLE_BLANK, 'У milestone есть название');
  }
  return {
    repositoryId: githubRepositoryId(input.repositoryId),
    milestoneNumber: milestoneNumberOf(input.milestoneNumber),
    title,
    state: milestoneState(input.state),
    dueOn: milestoneDueOn(input.dueOn),
  };
}

/** Поля milestone. Срок пуст, пока в GitHub его нет. */
export function defineMilestone(input: {
  id: string;
  repositoryId: string;
  milestoneNumber: number;
  title: string;
  state: string;
  dueOn: string | null;
}): Milestone {
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.MILESTONE_ID_BLANK, 'У milestone есть id');
  }
  return { id: input.id.trim(), ...milestoneFields(input) };
}

/** Природный ключ milestone: репозиторий и номер. Проекта в ключе нет. */
export function milestoneNaturalKey(
  repositoryId: string,
  milestoneNumber: number,
): { repositoryId: string; milestoneNumber: number } {
  return {
    repositoryId: githubRepositoryId(repositoryId),
    milestoneNumber: milestoneNumberOf(milestoneNumber),
  };
}
