import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { workflowConclusion } from '../domain/github/ci-status.ts';
import type {
  GithubDelivery,
  IssueDelivery,
  IssueLinkDelivery,
  MilestoneDelivery,
  PullRequestDelivery,
  PushCommitDelivery,
  PushDelivery,
  WorkflowDelivery,
} from '../domain/github/delivery.ts';
import {
  ISSUE_LINK_ADDED,
  ISSUE_LINK_BLOCKED_BY,
  ISSUE_LINK_REMOVED,
  ISSUE_LINK_SUB_ISSUE,
} from '../domain/github/issue-dependency.ts';
import { recordGithubDelivery } from '../domain/github/delivery.ts';
import { DomainError } from '../domain/shared/errors.ts';
import type { Clock } from '../domain/shared/clock.ts';
import { EVENT_TYPES, EventRejected, type PayloadByType } from '../events/index.ts';
import type { EventJournal } from '../events/journal.ts';

/** Путь приёма доставки GitHub App. Регистрация hook — в развёртывании. */
export const GITHUB_WEBHOOK_PATH = '/github/webhook';

const SIGNATURE_PREFIX = 'sha256=';
const EVENT_ISSUES = 'issues';
const EVENT_PULL_REQUEST = 'pull_request';
const EVENT_ISSUE_DEPENDENCIES = 'issue_dependencies';
const EVENT_SUB_ISSUES = 'sub_issues';
const EVENT_MILESTONE = 'milestone';
const EVENT_WORKFLOW_RUN = 'workflow_run';
const EVENT_PUSH = 'push';
const ACTION_COMPLETED = 'completed';
const STATUS_OK = 200;
const STATUS_BAD = 400;
const STATUS_UNAUTHORIZED = 401;

export interface GithubWebhookRequest {
  secret: string;
  eventName: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  body: Buffer;
  journal: EventJournal;
  clock: Clock;
  /** Пишет зеркало issue после новой доставки. Повтор ключа сюда не приходит. */
  applyIssue?: (payload: PayloadByType['github.issue_changed']) => Promise<void>;
  /** Пишет связь issues после новой доставки. Повтор ключа сюда не приходит. */
  applyIssueLink?: (payload: PayloadByType['github.issue_links_changed']) => Promise<void>;
  /** Пишет milestone после новой доставки. Повтор ключа сюда не приходит. */
  applyMilestone?: (payload: PayloadByType['github.milestone_changed']) => Promise<void>;
  /** Пишет pull request после новой доставки. Повтор ключа сюда не приходит. */
  applyPullRequest?: (payload: PayloadByType['github.pull_request_changed']) => Promise<void>;
  /** Пишет CI после новой доставки workflow. Повтор ключа сюда не приходит. */
  applyWorkflow?: (payload: PayloadByType['github.workflow_completed']) => Promise<void>;
  /** Пишет хвост коммитов после новой доставки push. Повтор ключа сюда не приходит. */
  applyCommits?: (payload: PayloadByType['github.commits_pushed']) => Promise<void>;
}

export interface GithubWebhookHttpDeps {
  secret: string;
  clock: Clock;
  isolate: (
    run: (
      journal: EventJournal,
      applyIssue: (payload: PayloadByType['github.issue_changed']) => Promise<void>,
      applyIssueLink: (payload: PayloadByType['github.issue_links_changed']) => Promise<void>,
      applyMilestone: (payload: PayloadByType['github.milestone_changed']) => Promise<void>,
      applyPullRequest: (payload: PayloadByType['github.pull_request_changed']) => Promise<void>,
      applyWorkflow: (payload: PayloadByType['github.workflow_completed']) => Promise<void>,
      applyCommits: (payload: PayloadByType['github.commits_pushed']) => Promise<void>,
    ) => Promise<number>,
  ) => Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value;
}

function numberValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function login(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return text(value.login);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Подпись `X-Hub-Signature-256` секретом GitHub App. Тело сравнивается в сырых байтах. */
export function verifyGithubWebhookSignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (secret.length === 0 || signature === undefined) return false;
  const presented = signature.trim();
  if (!presented.startsWith(SIGNATURE_PREFIX)) return false;
  const actual = presented.slice(SIGNATURE_PREFIX.length).toLowerCase();
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function repositoryId(body: Record<string, unknown>): string | null {
  if (!isRecord(body.repository)) return null;
  const id = body.repository.id;
  if (typeof id === 'string') return id;
  const numeric = numberValue(id);
  if (numeric === null) return null;
  return String(numeric);
}

function assignees(issue: Record<string, unknown>): string[] {
  if (!Array.isArray(issue.assignees)) return [];
  const logins: string[] = [];
  for (const item of issue.assignees) {
    const name = login(item);
    if (name !== null) logins.push(name);
  }
  return logins;
}

function parseIssue(deliveryId: string, body: Record<string, unknown>): IssueDelivery | null {
  if (!isRecord(body.issue)) return null;
  const repository = repositoryId(body);
  const number = numberValue(body.issue.number);
  const title = text(body.issue.title);
  const state = text(body.issue.state);
  const updatedAt = text(body.issue.updated_at);
  if (repository === null || number === null || title === null || state === null || updatedAt === null) return null;
  const reason = body.issue.state_reason;
  return {
    kind: 'issues',
    deliveryId,
    repositoryId: repository,
    number,
    title,
    state,
    stateReason: reason === null ? null : text(reason),
    assignees: assignees(body.issue),
    closedByLogin: login(body.issue.closed_by),
    updatedAt,
    isPullRequest: isRecord(body.issue.pull_request),
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
}

function parsePullRequest(deliveryId: string, body: Record<string, unknown>): PullRequestDelivery | null {
  if (!isRecord(body.pull_request)) return null;
  const repository = repositoryId(body);
  const number = numberValue(body.pull_request.number);
  const title = text(body.pull_request.title);
  const state = text(body.pull_request.state);
  const updatedAt = text(body.pull_request.updated_at);
  const author = login(body.pull_request.user);
  if (repository === null || number === null || title === null || state === null || updatedAt === null || author === null) {
    return null;
  }
  const mergedAt = body.pull_request.merged_at;
  return {
    kind: 'pull_request',
    deliveryId,
    repositoryId: repository,
    number,
    title,
    state,
    merged: body.pull_request.merged === true,
    authorLogin: author,
    updatedAt,
    mergedAt: mergedAt === null || mergedAt === undefined ? null : text(mergedAt),
    mergedByLogin: login(body.pull_request.merged_by),
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
}

function githubIssueNumber(value: unknown): number | 'absent' | 'invalid' {
  if (value === undefined || value === null) return 'absent';
  if (!isRecord(value)) return 'invalid';
  if (value.number === undefined || value.number === null) return 'absent';
  const number = numberValue(value.number);
  if (number === null) return 'invalid';
  return number;
}

function sameRepository(repository: string, repo: unknown): boolean {
  if (repo === undefined || repo === null) return true;
  if (!isRecord(repo)) return false;
  if (typeof repo.id === 'string') return repo.id.trim() === repository;
  const numeric = numberValue(repo.id);
  if (numeric === null) return false;
  return String(numeric) === repository;
}

function linkDelivery(
  deliveryId: string,
  body: Record<string, unknown>,
  repository: string,
  issueNumber: number,
  dependsOnIssueNumber: number,
  linkType: IssueLinkDelivery['linkType'],
  action: IssueLinkDelivery['action'],
): IssueLinkDelivery {
  return {
    kind: 'issue_link',
    deliveryId,
    repositoryId: repository,
    issueNumber,
    dependsOnIssueNumber,
    linkType,
    action,
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
}

/**
 * `blocked by`: issue — заблокированный, depends on — блокирующий.
 * `sub_issue`: issue — родитель, depends on — подзадача.
 * Чужой репозиторий и неполное тело не становятся фактом этого зеркала.
 */
function parseIssueLink(eventName: string, deliveryId: string, body: Record<string, unknown>): GithubDelivery | null {
  const actionName = text(body.action)?.trim().toLowerCase() ?? '';
  const repository = repositoryId(body);
  if (repository === null) return null;
  const blocked = actionName === 'blocked_by_added' || actionName === 'blocking_added'
    ? ISSUE_LINK_ADDED
    : actionName === 'blocked_by_removed' || actionName === 'blocking_removed'
      ? ISSUE_LINK_REMOVED
      : null;
  const sub = actionName === 'sub_issue_added' || actionName === 'parent_issue_added'
    ? ISSUE_LINK_ADDED
    : actionName === 'sub_issue_removed' || actionName === 'parent_issue_removed'
      ? ISSUE_LINK_REMOVED
      : null;
  if (eventName === EVENT_ISSUE_DEPENDENCIES) {
    if (blocked === null) return { kind: 'other', deliveryId, eventName };
    if (!sameRepository(repository, body.blocking_issue_repo)) return { kind: 'other', deliveryId, eventName };
    const issueNumber = githubIssueNumber(body.blocked_issue);
    const dependsOn = githubIssueNumber(body.blocking_issue);
    if (issueNumber === 'absent' || dependsOn === 'absent') return { kind: 'other', deliveryId, eventName };
    if (issueNumber === 'invalid' || dependsOn === 'invalid') return null;
    return linkDelivery(deliveryId, body, repository, issueNumber, dependsOn, ISSUE_LINK_BLOCKED_BY, blocked);
  }
  if (sub === null) return { kind: 'other', deliveryId, eventName };
  if (!sameRepository(repository, body.parent_issue_repo)) return { kind: 'other', deliveryId, eventName };
  const issueNumber = githubIssueNumber(body.parent_issue);
  const dependsOn = githubIssueNumber(body.sub_issue);
  if (issueNumber === 'absent' || dependsOn === 'absent') return { kind: 'other', deliveryId, eventName };
  if (issueNumber === 'invalid' || dependsOn === 'invalid') return null;
  return linkDelivery(deliveryId, body, repository, issueNumber, dependsOn, ISSUE_LINK_SUB_ISSUE, sub);
}

function parseMilestone(deliveryId: string, body: Record<string, unknown>): MilestoneDelivery | null {
  if (!isRecord(body.milestone)) return null;
  const repository = repositoryId(body);
  const number = numberValue(body.milestone.number);
  const title = text(body.milestone.title);
  const state = text(body.milestone.state);
  if (repository === null || number === null || title === null || state === null) return null;
  const due = body.milestone.due_on;
  let dueOn: string | null = null;
  if (due !== null && due !== undefined) {
    dueOn = text(due);
    if (dueOn === null) return null;
  }
  return {
    kind: 'milestone',
    deliveryId,
    repositoryId: repository,
    number,
    title,
    state,
    dueOn,
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
}

function workflowPullRequestNumbers(value: unknown): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const number = numberValue(item.number);
    if (number === null) return null;
    numbers.push(number);
  }
  return numbers;
}

/**
 * `workflow_run` со статусом completed становится фактом CI.
 * Незавершённый прогон и пустое тело фактом не являются.
 * Имя ветки нужно только чтобы отличить основную; в зеркало оно не пишется.
 */
function parseWorkflow(deliveryId: string, body: Record<string, unknown>): GithubDelivery | null {
  const action = text(body.action)?.trim().toLowerCase() ?? '';
  if (action !== ACTION_COMPLETED || !isRecord(body.workflow_run)) {
    return { kind: 'other', deliveryId, eventName: EVENT_WORKFLOW_RUN };
  }
  const repository = repositoryId(body);
  const branch = text(body.workflow_run.head_branch);
  if (repository === null || branch === null) return null;
  const rawConclusion = body.workflow_run.conclusion;
  if (rawConclusion !== null && rawConclusion !== undefined && typeof rawConclusion !== 'string') return null;
  const conclusion = workflowConclusion(typeof rawConclusion === 'string' ? rawConclusion : null);
  if (conclusion === null) return { kind: 'other', deliveryId, eventName: EVENT_WORKFLOW_RUN };
  const pullRequestNumbers = workflowPullRequestNumbers(body.workflow_run.pull_requests);
  if (pullRequestNumbers === null) return null;
  const defaultBranch = isRecord(body.repository) ? text(body.repository.default_branch) : null;
  const delivery: WorkflowDelivery = {
    kind: 'workflow',
    deliveryId,
    repositoryId: repository,
    branch,
    isDefaultBranch: defaultBranch !== null && defaultBranch.trim() === branch.trim(),
    conclusion,
    pullRequestNumbers,
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
  return delivery;
}

/**
 * Коммит push: sha, сообщение, автор и время.
 * Без логина автора коммит в хвост не входит: отнести его не к кому.
 * Неполное тело одного коммита не отменяет остальные.
 */
function parsePushCommit(value: unknown): PushCommitDelivery | 'skip' | 'invalid' {
  if (!isRecord(value)) return 'invalid';
  const shaSource = value.id !== undefined ? value.id : value.sha;
  if (shaSource === undefined || shaSource === null) return 'skip';
  if (typeof shaSource !== 'string') return 'invalid';
  const message = value.message;
  if (message === undefined || message === null) return 'skip';
  if (typeof message !== 'string') return 'invalid';
  const created = value.timestamp !== undefined ? value.timestamp : value.created_at;
  if (created === undefined || created === null) return 'skip';
  if (typeof created !== 'string') return 'invalid';
  if (!isRecord(value.author)) return 'skip';
  const author = text(value.author.username);
  if (author === null || author.trim().length === 0) return 'skip';
  if (shaSource.trim().length === 0 || message.trim().length === 0 || created.trim().length === 0) return 'skip';
  return { sha: shaSource, message, authorLogin: author, createdAt: created };
}

/** `push` становится фактом коммитов. Пустой список — push без новых коммитов, факт всё равно есть. */
function parsePush(deliveryId: string, body: Record<string, unknown>): GithubDelivery | null {
  const repository = repositoryId(body);
  if (repository === null) return null;
  if (body.commits !== undefined && body.commits !== null && !Array.isArray(body.commits)) return null;
  const raw = Array.isArray(body.commits) ? body.commits : [];
  const commits: PushCommitDelivery[] = [];
  for (const item of raw) {
    const parsed = parsePushCommit(item);
    if (parsed === 'invalid') return null;
    if (parsed === 'skip') continue;
    commits.push(parsed);
  }
  const delivery: PushDelivery = {
    kind: 'push',
    deliveryId,
    repositoryId: repository,
    commits,
    senderLogin: isRecord(body.sender) ? login(body.sender) : null,
  };
  return delivery;
}

function parseDelivery(eventName: string, deliveryId: string, json: unknown): GithubDelivery | null {
  if (!isRecord(json)) return null;
  if (eventName === EVENT_ISSUES) return parseIssue(deliveryId, json);
  if (eventName === EVENT_PULL_REQUEST) return parsePullRequest(deliveryId, json);
  if (eventName === EVENT_ISSUE_DEPENDENCIES || eventName === EVENT_SUB_ISSUES) {
    return parseIssueLink(eventName, deliveryId, json);
  }
  if (eventName === EVENT_MILESTONE) return parseMilestone(deliveryId, json);
  if (eventName === EVENT_WORKFLOW_RUN) return parseWorkflow(deliveryId, json);
  if (eventName === EVENT_PUSH) return parsePush(deliveryId, json);
  return { kind: 'other', deliveryId, eventName };
}

/**
 * Проверяет подпись и публикует факт в журнал.
 * Неверная подпись не читает доставку. Повтор ключа не пишет второе событие.
 * Записи в GitHub здесь нет.
 */
export async function acceptGithubWebhook(input: GithubWebhookRequest): Promise<number> {
  if (!verifyGithubWebhookSignature(input.secret, input.body, input.signature)) return STATUS_UNAUTHORIZED;
  const eventName = input.eventName?.trim().toLowerCase() ?? '';
  const deliveryId = input.deliveryId?.trim() ?? '';
  if (eventName.length === 0 || deliveryId.length === 0) return STATUS_BAD;
  let json: unknown;
  try {
    json = JSON.parse(input.body.toString('utf8')) as unknown;
  } catch {
    return STATUS_BAD;
  }
  const delivery = parseDelivery(eventName, deliveryId, json);
  if (delivery === null) return STATUS_BAD;
  let result: Awaited<ReturnType<typeof recordGithubDelivery>>;
  try {
    result = await recordGithubDelivery(input.journal, input.clock, delivery);
  } catch (error) {
    if (error instanceof DomainError || error instanceof EventRejected) return STATUS_BAD;
    throw error;
  }
  if (input.applyIssue !== undefined && result.status === 'applied' && result.eventType === EVENT_TYPES.GITHUB_ISSUE_CHANGED) {
    await input.applyIssue(result.payload);
  }
  if (
    input.applyIssueLink !== undefined &&
    result.status === 'applied' &&
    result.eventType === EVENT_TYPES.GITHUB_ISSUE_LINKS_CHANGED
  ) {
    await input.applyIssueLink(result.payload);
  }
  if (
    input.applyMilestone !== undefined &&
    result.status === 'applied' &&
    result.eventType === EVENT_TYPES.GITHUB_MILESTONE_CHANGED
  ) {
    await input.applyMilestone(result.payload);
  }
  if (
    input.applyPullRequest !== undefined &&
    result.status === 'applied' &&
    result.eventType === EVENT_TYPES.GITHUB_PULL_REQUEST_CHANGED
  ) {
    await input.applyPullRequest(result.payload);
  }
  if (
    input.applyWorkflow !== undefined &&
    result.status === 'applied' &&
    result.eventType === EVENT_TYPES.GITHUB_WORKFLOW_COMPLETED
  ) {
    await input.applyWorkflow(result.payload);
  }
  if (
    input.applyCommits !== undefined &&
    result.status === 'applied' &&
    result.eventType === EVENT_TYPES.GITHUB_COMMITS_PUSHED
  ) {
    await input.applyCommits(result.payload);
  }
  return STATUS_OK;
}

/**
 * HTTP-вход той же проверки. Ответ без тела: GitHub смотрит на код.
 * Отказ записи всплывает: `500` и причину пишет общий вход HTTP.
 */
export async function acceptGithubWebhookHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GithubWebhookHttpDeps,
): Promise<void> {
  const body = await readBody(req);
  const eventName = header(req, 'x-github-event');
  const deliveryId = header(req, 'x-github-delivery');
  const signature = header(req, 'x-hub-signature-256');
  const status = await deps.isolate((
    journal,
    applyIssue,
    applyIssueLink,
    applyMilestone,
    applyPullRequest,
    applyWorkflow,
    applyCommits,
  ) =>
    acceptGithubWebhook({
      secret: deps.secret,
      eventName,
      deliveryId,
      signature,
      body,
      journal,
      clock: deps.clock,
      applyIssue,
      applyIssueLink,
      applyMilestone,
      applyPullRequest,
      applyWorkflow,
      applyCommits,
    }),
  );
  if (!res.writableEnded) {
    res.statusCode = status;
    res.end();
  }
}
