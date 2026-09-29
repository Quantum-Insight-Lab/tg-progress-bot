import { App } from 'octokit';
import type { InstallationRepositorySource } from '../domain/github/repository.ts';
import { DOMAIN_ERROR, DomainError } from '../domain/shared/errors.ts';

/** Учётные данные GitHub App. Поля личного токена здесь нет. */
export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
}

interface ListedRepository {
  id: string;
  name: string;
  owner: { login: string } | null;
}

interface InstallationRepositoryListing {
  eachRepository: {
    iterator(): AsyncIterable<{ repository: ListedRepository }>;
  };
}

const PERSONAL_TOKEN = /^(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/;

function normalizePem(value: string): string {
  return value.replaceAll('\\n', '\n').trim();
}

/**
 * App id и приватный ключ. Строка личного токена отклоняется.
 * Переменные `GITHUB_TOKEN` и `GH_TOKEN` эта функция не читает.
 */
export function readGithubAppCredentials(env: NodeJS.ProcessEnv): GithubAppCredentials | null {
  const appId = env.GITHUB_APP_ID?.trim() ?? '';
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? '';
  if (appId.length === 0 && privateKey.trim().length === 0) return null;
  return { appId, privateKey };
}

/** Доступ только как GitHub App. Личный токен в любом из полей — отказ. */
export function assertGithubAppCredentials(credentials: GithubAppCredentials): void {
  const appId = credentials.appId.trim();
  const privateKey = credentials.privateKey.trim();
  if (PERSONAL_TOKEN.test(appId) || PERSONAL_TOKEN.test(privateKey)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_APP, 'личный токен не принимается');
  }
  if (!/^[1-9]\d*$/.test(appId)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_APP, 'GitHub App: нужен числовой app id');
  }
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_APP, 'GitHub App: нужен приватный ключ приложения');
  }
}

/** Один конструктор App: список установки и сверка зеркала ходят через него. */
export function createGithubInstallationApp(credentials: GithubAppCredentials): App {
  assertGithubAppCredentials(credentials);
  return new App({
    appId: credentials.appId.trim(),
    privateKey: normalizePem(credentials.privateKey),
  });
}

function defaultListing(credentials: GithubAppCredentials): InstallationRepositoryListing {
  const app = createGithubInstallationApp(credentials);
  return {
    eachRepository: {
      async *iterator() {
        for await (const item of app.eachRepository.iterator()) {
          const owner = item.repository.owner;
          const login = owner.login;
          yield {
            repository: {
              id: String(item.repository.id),
              name: item.repository.name,
              owner: login.trim().length === 0 ? null : { login },
            },
          };
        }
      },
    },
  };
}

/**
 * Один клиент Octokit: репозитории всех установок GitHub App.
 * Методы записи в GitHub этот клиент не открывает.
 */
export function createGithubAppClient(
  credentials: GithubAppCredentials,
  listing: (credentials: GithubAppCredentials) => InstallationRepositoryListing = defaultListing,
): InstallationRepositorySource {
  assertGithubAppCredentials(credentials);
  const app = listing(credentials);
  return {
    async list() {
      const found: { id: string; owner: string; name: string }[] = [];
      try {
        for await (const item of app.eachRepository.iterator()) {
          const owner = item.repository.owner;
          if (owner === null || owner.login.trim().length === 0) {
            throw new DomainError(DOMAIN_ERROR.REPOSITORY_OWNER_BLANK, 'у репозитория есть owner');
          }
          found.push({ id: String(item.repository.id), owner: owner.login, name: item.repository.name });
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError(DOMAIN_ERROR.REPOSITORY_UNAVAILABLE, 'установка GitHub App не прочитана');
      }
      return found;
    },
  };
}
