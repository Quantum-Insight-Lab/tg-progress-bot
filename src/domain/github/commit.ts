import { COMMITS_TAIL_DAYS } from '../../config/constants.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { githubRepositoryId } from './repository.ts';

/**
 * Коммит зеркала (E-15): хвост коммитов, а не вся история.
 * Ключ — id. Природный ключ — репозиторий и sha, не проект и не задача.
 * Автор — логин того, кто сделал коммит.
 */
export interface Commit {
  id: string;
  repositoryId: string;
  sha: string;
  message: string;
  authorLogin: string;
  createdAt: string;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/** Длина суток — шаг календаря. Глубина хвоста — `COMMITS_TAIL_DAYS`, не это число. */
function millisecondsInDay(): number {
  return Date.UTC(0, 0, 1 + 1) - Date.UTC(0, 0, 1);
}

/** Момент, старше которого коммит в зеркало не кладётся. */
export function commitTailStartsAt(now: Date): number {
  return now.getTime() - COMMITS_TAIL_DAYS * millisecondsInDay();
}

/** Коммит внутри окна хвоста. Ровно на границе окна ещё хранится. */
export function commitKeptInTail(createdAt: string, now: Date): boolean {
  const at = Date.parse(createdAt);
  return !Number.isNaN(at) && at >= commitTailStartsAt(now);
}

function shaOf(value: string): string {
  const sha = value.trim().toLowerCase();
  if (sha.length === 0) throw new DomainError(DOMAIN_ERROR.COMMIT_SHA_BLANK, 'У коммита есть sha');
  return sha;
}

function messageOf(value: string): string {
  const message = value.trim();
  if (message.length === 0) throw new DomainError(DOMAIN_ERROR.COMMIT_MESSAGE_BLANK, 'У коммита есть сообщение');
  return message;
}

function authorLoginOf(value: string): string {
  const login = value.trim();
  if (login.length === 0) throw new DomainError(DOMAIN_ERROR.COMMIT_AUTHOR_LOGIN, 'У коммита есть автор');
  return login;
}

function createdAtOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new DomainError(DOMAIN_ERROR.COMMIT_CREATED_AT, 'Дата коммита — метка времени');
  }
  return trimmed;
}

/** Поля коммита без id. Проекта и задачи среди них нет. */
export function commitFields(input: {
  repositoryId: string;
  sha: string;
  message: string;
  authorLogin: string;
  createdAt: string;
}): Omit<Commit, 'id'> {
  return {
    repositoryId: githubRepositoryId(input.repositoryId),
    sha: shaOf(input.sha),
    message: messageOf(input.message),
    authorLogin: authorLoginOf(input.authorLogin),
    createdAt: createdAtOf(input.createdAt),
  };
}

/** Поля коммита. Автор — логин того, кто сделал коммит, не того, кто отправил push. */
export function defineCommit(input: {
  id: string;
  repositoryId: string;
  sha: string;
  message: string;
  authorLogin: string;
  createdAt: string;
}): Commit {
  if (blank(input.id)) throw new DomainError(DOMAIN_ERROR.COMMIT_ID_BLANK, 'У коммита есть id');
  return { id: input.id.trim(), ...commitFields(input) };
}

/** Природный ключ коммита: репозиторий и sha. Проекта в ключе нет. */
export function commitNaturalKey(repositoryId: string, sha: string): { repositoryId: string; sha: string } {
  return {
    repositoryId: githubRepositoryId(repositoryId),
    sha: shaOf(sha),
  };
}

/** Коммиты одной доставки без возраста: один sha — одна запись, первое вхождение остаётся. */
export function pushedCommits(
  commits: readonly { sha: string; message: string; authorLogin: string; createdAt: string }[],
): { sha: string; message: string; authorLogin: string; createdAt: string }[] {
  const seen = new Set<string>();
  const result: { sha: string; message: string; authorLogin: string; createdAt: string }[] = [];
  for (const commit of commits) {
    const sha = shaOf(commit.sha);
    if (seen.has(sha)) continue;
    seen.add(sha);
    result.push({
      sha,
      message: messageOf(commit.message),
      authorLogin: authorLoginOf(commit.authorLogin),
      createdAt: createdAtOf(commit.createdAt),
    });
  }
  return result;
}

/**
 * Хвост для зеркала: из доставки остаются коммиты не старше `COMMITS_TAIL_DAYS`.
 * Журнал событий при этом хранит всю доставку. Таблица — нет.
 */
export function commitsInTail(
  commits: readonly { repositoryId: string; sha: string; message: string; authorLogin: string; createdAt: string }[],
  now: Date,
): Omit<Commit, 'id'>[] {
  return commits.map((commit) => commitFields(commit)).filter((commit) => commitKeptInTail(commit.createdAt, now));
}
