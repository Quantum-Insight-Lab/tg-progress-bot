import { emit, EVENT_TYPES, payloadSchemaByType, type PayloadByType } from '../../events/index.ts';
import type { EventJournal } from '../../events/journal.ts';
import type { Clock } from '../shared/clock.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { issueLinkAction, issueLinkType, type IssueLinkAction, type IssueLinkType } from './issue-dependency.ts';
import { milestoneFields } from './milestone.ts';
import { githubRepositoryId } from './repository.ts';

/** Факт пришёл из GitHub, не из кнопки бота. */
export const GITHUB_DELIVERY_SOURCE = 'github';

/** Роль действующего лица в конверте: GitHub, не участник проекта. */
export const GITHUB_ACTOR_ROLE = 'github';

const ISSUE_SUBJECT = 'Issue';
const PULL_REQUEST_SUBJECT = 'PullRequest';
const MILESTONE_SUBJECT = 'Milestone';
const ACTOR_FALLBACK = 'github';
const STATE_OPEN = 'open';
const STATE_CLOSED = 'closed';
const STATE_MERGED = 'merged';
const REASON_COMPLETED = 'completed';
const REASON_NOT_PLANNED = 'not_planned';

/** Снимок issue из доставки webhook. Pull request сюда не входит. */
export interface IssueDelivery {
  kind: 'issues';
  deliveryId: string;
  repositoryId: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  assignees: readonly string[];
  closedByLogin: string | null;
  updatedAt: string;
  isPullRequest: boolean;
  senderLogin: string | null;
}

/** Снимок pull request из доставки webhook. */
export interface PullRequestDelivery {
  kind: 'pull_request';
  deliveryId: string;
  repositoryId: string;
  number: number;
  title: string;
  state: string;
  merged: boolean;
  authorLogin: string;
  updatedAt: string;
  mergedAt: string | null;
  mergedByLogin: string | null;
  senderLogin: string | null;
}

/** Связь `blocked by` или sub-issue из доставки webhook. */
export interface IssueLinkDelivery {
  kind: 'issue_link';
  deliveryId: string;
  repositoryId: string;
  issueNumber: number;
  dependsOnIssueNumber: number;
  linkType: IssueLinkType;
  action: IssueLinkAction;
  senderLogin: string | null;
}

/** Снимок milestone из доставки webhook. */
export interface MilestoneDelivery {
  kind: 'milestone';
  deliveryId: string;
  repositoryId: string;
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
  senderLogin: string | null;
}

/**
 * Подписанная доставка, для которой этот шаг не публикует факт.
 * События push и workflow — в своих issues.
 */
export interface OtherDelivery {
  kind: 'other';
  deliveryId: string;
  eventName: string;
}

export type GithubDelivery = IssueDelivery | PullRequestDelivery | IssueLinkDelivery | MilestoneDelivery | OtherDelivery;

export type GithubDeliveryResult =
  | { status: 'ignored' }
  | {
      status: 'applied' | 'duplicate';
      eventType: typeof EVENT_TYPES.GITHUB_ISSUE_CHANGED;
      payload: PayloadByType['github.issue_changed'];
    }
  | {
      status: 'applied' | 'duplicate';
      eventType: typeof EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED;
      payload: PayloadByType['github.pull_request_changed'];
    }
  | {
      status: 'applied' | 'duplicate';
      eventType: typeof EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED;
      payload: PayloadByType['github.issue_links_changed'];
    }
  | {
      status: 'applied' | 'duplicate';
      eventType: typeof EVENT_TYPES.GITHUB_MILESTONE_CHANGED;
      payload: PayloadByType['github.milestone_changed'];
    };

/** Команд записи в GitHub нет: синхронизация только в сторону бота. */
export function githubWriteCommands(): readonly [] {
  return [];
}

function deliveryIdOf(value: string): string {
  const id = value.trim();
  if (id.length === 0) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'ключ доставки GitHub пуст');
  return id;
}

function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function titleOf(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY_TITLE, 'у факта GitHub есть название');
  return title;
}

function timestamp(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY_DATE, 'дата факта GitHub');
  }
  return trimmed;
}

function optionalTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return timestamp(trimmed);
}

function loginOf(value: string): string {
  const login = value.trim();
  if (login.length === 0) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY_LOGIN, 'логин автора пуст');
  return login;
}

function optionalText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function logins(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const login = optionalText(value);
    if (login === null || seen.has(login)) continue;
    seen.add(login);
    result.push(login);
  }
  return result;
}

function issueState(value: string): 'open' | 'closed' {
  if (value === STATE_OPEN) return STATE_OPEN;
  if (value === STATE_CLOSED) return STATE_CLOSED;
  throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'состояние issue — open или closed');
}

function issueReason(state: 'open' | 'closed', value: string | null): 'completed' | 'not_planned' | null {
  if (state === STATE_OPEN) return null;
  if (value === REASON_COMPLETED) return REASON_COMPLETED;
  if (value === REASON_NOT_PLANNED) return REASON_NOT_PLANNED;
  return null;
}

function pullRequestState(state: string, merged: boolean): 'open' | 'closed' | 'merged' {
  if (merged) return STATE_MERGED;
  if (state === STATE_CLOSED) return STATE_CLOSED;
  if (state === STATE_OPEN) return STATE_OPEN;
  throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'состояние pull request — open, closed или merged');
}

function actorId(login: string | null): string {
  return login ?? ACTOR_FALLBACK;
}

function subjectId(repositoryId: string, number: number): string {
  return `${repositoryId}:${String(number)}`;
}

function storedIssue(payload: unknown): PayloadByType['github.issue_changed'] {
  const parsed = payloadSchemaByType[EVENT_TYPES.GITHUB_ISSUE_CHANGED].safeParse(payload);
  if (!parsed.success) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'факт issue не прочитан');
  return parsed.data;
}

function storedPullRequest(payload: unknown): PayloadByType['github.pull_request_changed'] {
  const parsed = payloadSchemaByType[EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED].safeParse(payload);
  if (!parsed.success) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'факт pull request не прочитан');
  return parsed.data;
}

function storedIssueLink(payload: unknown): PayloadByType['github.issue_links_changed'] {
  const parsed = payloadSchemaByType[EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED].safeParse(payload);
  if (!parsed.success) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'факт связи issue не прочитан');
  return parsed.data;
}

function storedMilestone(payload: unknown): PayloadByType['github.milestone_changed'] {
  const parsed = payloadSchemaByType[EVENT_TYPES.GITHUB_MILESTONE_CHANGED].safeParse(payload);
  if (!parsed.success) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'факт milestone не прочитан');
  return parsed.data;
}

async function recordMilestone(
  journal: EventJournal,
  clock: Clock,
  delivery: MilestoneDelivery,
  idempotencyKey: string,
): Promise<GithubDeliveryResult> {
  const fields = milestoneFields({
    repositoryId: delivery.repositoryId,
    milestoneNumber: delivery.number,
    title: delivery.title,
    state: delivery.state,
    dueOn: delivery.dueOn,
  });
  const payload: PayloadByType['github.milestone_changed'] = {
    repository_id: fields.repositoryId,
    milestone_number: fields.milestoneNumber,
    title: fields.title,
    state: fields.state,
    due_on: fields.dueOn,
  };
  const published = await emit(journal, {
    type: EVENT_TYPES.GITHUB_MILESTONE_CHANGED,
    source: GITHUB_DELIVERY_SOURCE,
    idempotencyKey,
    payload,
    actor: { id: actorId(optionalText(delivery.senderLogin)), role: GITHUB_ACTOR_ROLE },
    subject: { entity: MILESTONE_SUBJECT, id: subjectId(fields.repositoryId, fields.milestoneNumber) },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    if (published.row.eventType !== EVENT_TYPES.GITHUB_MILESTONE_CHANGED) {
      throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'ключ доставки уже занят');
    }
    return {
      status: 'duplicate',
      eventType: EVENT_TYPES.GITHUB_MILESTONE_CHANGED,
      payload: storedMilestone(published.row.payload),
    };
  }
  return { status: 'applied', eventType: EVENT_TYPES.GITHUB_MILESTONE_CHANGED, payload };
}

async function recordIssueLink(
  journal: EventJournal,
  clock: Clock,
  delivery: IssueLinkDelivery,
  idempotencyKey: string,
): Promise<GithubDeliveryResult> {
  if (!positiveInt(delivery.issueNumber) || !positiveInt(delivery.dependsOnIssueNumber)) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_NUMBER, 'номер issue — число GitHub');
  }
  if (delivery.issueNumber === delivery.dependsOnIssueNumber) {
    throw new DomainError(DOMAIN_ERROR.ISSUE_LINK_SELF, 'issue не зависит от себя');
  }
  const repositoryId = githubRepositoryId(delivery.repositoryId);
  const payload: PayloadByType['github.issue_links_changed'] = {
    repository_id: repositoryId,
    issue_number: delivery.issueNumber,
    depends_on_issue_number: delivery.dependsOnIssueNumber,
    link_type: issueLinkType(delivery.linkType),
    action: issueLinkAction(delivery.action),
  };
  const published = await emit(journal, {
    type: EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED,
    source: GITHUB_DELIVERY_SOURCE,
    idempotencyKey,
    payload,
    actor: { id: actorId(optionalText(delivery.senderLogin)), role: GITHUB_ACTOR_ROLE },
    subject: { entity: ISSUE_SUBJECT, id: subjectId(repositoryId, delivery.issueNumber) },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    if (published.row.eventType !== EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED) {
      throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'ключ доставки уже занят');
    }
    return {
      status: 'duplicate',
      eventType: EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED,
      payload: storedIssueLink(published.row.payload),
    };
  }
  return { status: 'applied', eventType: EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED, payload };
}

/**
 * Публикует факт доставки в журнал.
 * Повтор того же ключа доставки возвращает первую запись и ничего не меняет.
 * Pull request, пришедший как issue, в долю не попадает: события issue нет.
 */
export async function recordGithubDelivery(
  journal: EventJournal,
  clock: Clock,
  delivery: GithubDelivery,
): Promise<GithubDeliveryResult> {
  const idempotencyKey = deliveryIdOf(delivery.deliveryId);
  if (delivery.kind === 'other') return { status: 'ignored' };
  if (delivery.kind === 'issues') {
    if (delivery.isPullRequest) return { status: 'ignored' };
    if (!positiveInt(delivery.number)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'номер issue — число GitHub');
    const repositoryId = githubRepositoryId(delivery.repositoryId);
    const state = issueState(delivery.state);
    const payload: PayloadByType['github.issue_changed'] = {
      repository_id: repositoryId,
      issue_number: delivery.number,
      title: titleOf(delivery.title),
      state,
      state_reason: issueReason(state, optionalText(delivery.stateReason)),
      assignees: logins(delivery.assignees),
      closed_by_login: state === STATE_OPEN ? null : optionalText(delivery.closedByLogin),
      updated_at: timestamp(delivery.updatedAt),
    };
    const published = await emit(journal, {
      type: EVENT_TYPES.GITHUB_ISSUE_CHANGED,
      source: GITHUB_DELIVERY_SOURCE,
      idempotencyKey,
      payload,
      actor: { id: actorId(payload.closed_by_login ?? optionalText(delivery.senderLogin)), role: GITHUB_ACTOR_ROLE },
      subject: { entity: ISSUE_SUBJECT, id: subjectId(repositoryId, delivery.number) },
      occurredAt: clock.now(),
      causationId: null,
      correlationId: null,
    });
    if (published.status === 'duplicate') {
      if (published.row.eventType !== EVENT_TYPES.GITHUB_ISSUE_CHANGED) {
        throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'ключ доставки уже занят');
      }
      return { status: 'duplicate', eventType: EVENT_TYPES.GITHUB_ISSUE_CHANGED, payload: storedIssue(published.row.payload) };
    }
    return { status: 'applied', eventType: EVENT_TYPES.GITHUB_ISSUE_CHANGED, payload };
  }
  if (delivery.kind === 'issue_link') {
    return recordIssueLink(journal, clock, delivery, idempotencyKey);
  }
  if (delivery.kind === 'milestone') {
    return recordMilestone(journal, clock, delivery, idempotencyKey);
  }
  if (!positiveInt(delivery.number)) throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'номер pull request — число GitHub');
  const repositoryId = githubRepositoryId(delivery.repositoryId);
  const state = pullRequestState(delivery.state, delivery.merged);
  const payload: PayloadByType['github.pull_request_changed'] = {
    repository_id: repositoryId,
    pull_request_number: delivery.number,
    title: titleOf(delivery.title),
    state,
    author_login: loginOf(delivery.authorLogin),
    updated_at: timestamp(delivery.updatedAt),
    merged_at: state === STATE_MERGED ? optionalTimestamp(delivery.mergedAt) : null,
    merged_by_login: state === STATE_MERGED ? optionalText(delivery.mergedByLogin) : null,
  };
  const published = await emit(journal, {
    type: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
    source: GITHUB_DELIVERY_SOURCE,
    idempotencyKey,
    payload,
    actor: { id: payload.author_login, role: GITHUB_ACTOR_ROLE },
    subject: { entity: PULL_REQUEST_SUBJECT, id: subjectId(repositoryId, delivery.number) },
    occurredAt: clock.now(),
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    if (published.row.eventType !== EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED) {
      throw new DomainError(DOMAIN_ERROR.GITHUB_DELIVERY, 'ключ доставки уже занят');
    }
    return {
      status: 'duplicate',
      eventType: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED,
      payload: storedPullRequest(published.row.payload),
    };
  }
  return { status: 'applied', eventType: EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED, payload };
}
