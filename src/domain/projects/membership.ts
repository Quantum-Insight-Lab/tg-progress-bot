import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { PRIVATE_CHAT } from './create-project.ts';
import { defineProjectMember, leadsTasks, MEMBER_ROLE, type ProjectMember, type ProjectRole } from './member.ts';
import type { User } from './user.ts';

/** Кто меняет состав. В событии это роль `root`. */
export const MEMBERSHIP_ACTOR_ROLE = 'root';

const MEMBER_SUBJECT = 'ProjectMember';

/** Участник на экране: роль этого проекта, не другая. */
export interface ProjectMemberView {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  name: string;
  telegramUserId: string;
}

export interface ParticipantsView {
  project: { id: string; name: string };
  candidates: User[];
  members: ProjectMemberView[];
}

/**
 * Порт состава внутри уже открытой транзакции.
 * Незакрытые задачи читает порт: контекст задач на удаление не вызывается.
 */
export interface MembershipStore {
  hasMembership(userId: string): Promise<boolean>;
  projectsNamed(name: string): Promise<Array<{ id: string; name: string }>>;
  projectExists(projectId: string): Promise<boolean>;
  candidates(projectId: string): Promise<User[]>;
  members(projectId: string): Promise<ProjectMemberView[]>;
  findMember(projectId: string, userId: string): Promise<ProjectMemberView | null>;
  insert(member: ProjectMember): Promise<void>;
  deleteMember(memberId: string): Promise<void>;
  unclosedTaskIds(projectId: string, userId: string): Promise<string[]>;
}

export interface MembershipCommand {
  actor: User | null;
  chat: string;
}

export interface ShowParticipants extends MembershipCommand {
  projectName: string;
}

export interface MemberTarget extends MembershipCommand {
  projectId: string;
  target: User | null;
}

export interface ChangeMember extends MemberTarget {
  idempotencyKey: string;
}

export interface AddMember extends ChangeMember {
  memberId: string;
}

/** Порт для адаптера Telegram. Часы, id строки и транзакция — у реализации. */
export interface MembershipActions {
  open(input: { telegramUserId: string; projectName: string; chat: string }): Promise<ParticipantsView>;
  add(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<{ name: string; role: typeof MEMBER_ROLE; projectName: string }>;
  describeRemoval(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    chat: string;
  }): Promise<{ name: string }>;
  remove(input: {
    telegramUserId: string;
    projectId: string;
    targetTelegramUserId: string;
    chat: string;
    idempotencyKey: string;
  }): Promise<{ name: string; cancelledTaskIds: string[] }>;
}

async function requireRoot(store: MembershipStore, actor: User | null, chat: string): Promise<User> {
  if (chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.MEMBER_CHAT, 'участники меняются в личке');
  }
  if (actor === null || !actor.isRoot) {
    const member = actor !== null && (await store.hasMembership(actor.id));
    if (!member) throw new DomainError(DOMAIN_ERROR.MEMBER_ACCESS, 'нет доступа');
    throw new DomainError(DOMAIN_ERROR.MEMBER_ACTOR, 'участников меняет корень');
  }
  return actor;
}

function idempotencyKeyOf(value: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(DOMAIN_ERROR.MEMBER_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  return key;
}

async function requireProject(store: MembershipStore, projectId: string): Promise<void> {
  if (!(await store.projectExists(projectId))) {
    throw new DomainError(DOMAIN_ERROR.MEMBER_PROJECT_MISSING, 'проект не найден');
  }
}

/** Люди, которые уже нажали `/start` и ещё не в этом проекте. Корень в список не входит. */
export async function listParticipants(store: MembershipStore, input: ShowParticipants): Promise<ParticipantsView> {
  await requireRoot(store, input.actor, input.chat);
  const name = input.projectName.trim();
  if (name.length === 0) throw new DomainError(DOMAIN_ERROR.MEMBER_PROJECT_MISSING, 'проект не найден');
  const projects = await store.projectsNamed(name);
  if (projects.length !== 1) {
    throw new DomainError(
      projects.length === 0 ? DOMAIN_ERROR.MEMBER_PROJECT_MISSING : DOMAIN_ERROR.MEMBER_PROJECT_AMBIGUOUS,
      projects.length === 0 ? 'проект не найден' : 'имя проекта не одно',
    );
  }
  const project = projects[0];
  if (project === undefined) throw new DomainError(DOMAIN_ERROR.MEMBER_PROJECT_MISSING, 'проект не найден');
  const waiting = await store.candidates(project.id);
  return {
    project,
    candidates: waiting.filter((user) => !user.isRoot),
    members: await store.members(project.id),
  };
}

/**
 * Добавляет человека как `member`.
 * Роль пишется в строку этого проекта и не трогает его роль в другом.
 */
export async function addProjectMember(
  store: MembershipStore,
  journal: EventJournal,
  clock: Clock,
  input: AddMember,
): Promise<ProjectMember> {
  const actor = await requireRoot(store, input.actor, input.chat);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  await requireProject(store, input.projectId);
  const target = input.target;
  if (target === null || target.isRoot) {
    throw new DomainError(DOMAIN_ERROR.MEMBER_NOT_CANDIDATE, 'добавить можно того, кто нажал /start и не является корнем');
  }
  const existing = await store.findMember(input.projectId, target.id);
  if (existing !== null) throw new DomainError(DOMAIN_ERROR.MEMBER_ALREADY, 'уже в проекте');
  void leadsTasks(MEMBER_ROLE);
  const member = defineProjectMember({
    id: input.memberId,
    projectId: input.projectId,
    userId: target.id,
    role: MEMBER_ROLE,
  });
  await store.insert(member);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_MEMBER_ADDED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      project_id: member.projectId,
      user_id: member.userId,
      role: member.role,
    },
    actor: { id: actor.id, role: MEMBERSHIP_ACTOR_ROLE },
    subject: { entity: MEMBER_SUBJECT, id: member.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.MEMBER_DUPLICATE, 'project.member_added уже записан');
  }
  return member;
}

/** Имя для подтверждения. Строку участника этот шаг не снимает. */
export async function describeMemberRemoval(
  store: MembershipStore,
  input: MemberTarget,
): Promise<ProjectMemberView> {
  await requireRoot(store, input.actor, input.chat);
  await requireProject(store, input.projectId);
  const target = input.target;
  if (target === null) throw new DomainError(DOMAIN_ERROR.MEMBER_ABSENT, 'в проекте этого человека нет');
  const member = await store.findMember(input.projectId, target.id);
  if (member === null) throw new DomainError(DOMAIN_ERROR.MEMBER_ABSENT, 'в проекте этого человека нет');
  return member;
}

/**
 * Снимает участника и в том же акте записывает id его незакрытых задач.
 * Повтор ключа откатывает снятие: второго события нет.
 */
export async function removeProjectMember(
  store: MembershipStore,
  journal: EventJournal,
  clock: Clock,
  input: ChangeMember,
): Promise<string[]> {
  const actor = await requireRoot(store, input.actor, input.chat);
  const idempotencyKey = idempotencyKeyOf(input.idempotencyKey);
  await requireProject(store, input.projectId);
  const target = input.target;
  if (target === null) throw new DomainError(DOMAIN_ERROR.MEMBER_ABSENT, 'в проекте этого человека нет');
  const member = await store.findMember(input.projectId, target.id);
  if (member === null) throw new DomainError(DOMAIN_ERROR.MEMBER_ABSENT, 'в проекте этого человека нет');
  const cancelledTaskIds = await store.unclosedTaskIds(input.projectId, target.id);
  await store.deleteMember(member.id);
  const published = await emit(journal, {
    type: EVENT_TYPES.PROJECT_MEMBER_REMOVED,
    source: 'telegram',
    idempotencyKey,
    payload: {
      project_id: input.projectId,
      user_id: target.id,
      cancelled_task_ids: cancelledTaskIds,
    },
    actor: { id: actor.id, role: MEMBERSHIP_ACTOR_ROLE },
    subject: { entity: MEMBER_SUBJECT, id: member.id },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.MEMBER_DUPLICATE, 'project.member_removed уже записан');
  }
  return cancelledTaskIds;
}
