import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GithubDelivery, IssueDelivery, PullRequestDelivery } from '../domain/github/delivery.ts';
import { recordGithubDelivery } from '../domain/github/delivery.ts';
import { DomainError } from '../domain/shared/errors.ts';
import type { Clock } from '../domain/shared/clock.ts';
import { EventRejected } from '../events/index.ts';
import type { EventJournal } from '../events/journal.ts';

/** Путь приёма доставки GitHub App. Регистрация hook — в развёртывании. */
export const GITHUB_WEBHOOK_PATH = '/github/webhook';

const SIGNATURE_PREFIX = 'sha256=';
const EVENT_ISSUES = 'issues';
const EVENT_PULL_REQUEST = 'pull_request';
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
}

export interface GithubWebhookHttpDeps {
  secret: string;
  journal: EventJournal;
  clock: Clock;
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

function parseDelivery(eventName: string, deliveryId: string, json: unknown): GithubDelivery | null {
  if (!isRecord(json)) return null;
  if (eventName === EVENT_ISSUES) return parseIssue(deliveryId, json);
  if (eventName === EVENT_PULL_REQUEST) return parsePullRequest(deliveryId, json);
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
  try {
    await recordGithubDelivery(input.journal, input.clock, delivery);
  } catch (error) {
    if (error instanceof DomainError || error instanceof EventRejected) return STATUS_BAD;
    throw error;
  }
  return STATUS_OK;
}

/** HTTP-вход той же проверки. Ответ без тела: GitHub смотрит на код. */
export async function acceptGithubWebhookHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GithubWebhookHttpDeps,
): Promise<void> {
  try {
    const body = await readBody(req);
    const status = await acceptGithubWebhook({
      secret: deps.secret,
      eventName: header(req, 'x-github-event'),
      deliveryId: header(req, 'x-github-delivery'),
      signature: header(req, 'x-hub-signature-256'),
      body,
      journal: deps.journal,
      clock: deps.clock,
    });
    if (!res.writableEnded) {
      res.statusCode = status;
      res.end();
    }
  } catch {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end();
    }
  }
}
