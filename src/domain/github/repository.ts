import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Личка — единственный вход, где показывают репозитории установки. */
const PRIVATE_CHAT = 'private';

/** Репозиторий установки GitHub App. Ключ зеркала — `id` GitHub. */
export interface Repository {
  id: string;
  owner: string;
  name: string;
}

export interface InstallationRepositorySource {
  list(): Promise<readonly { id: string; owner: string; name: string }[]>;
}

/** Порт `repositories` внутри уже открытой транзакции. */
export interface RepositoryStore {
  upsert(repository: Repository): Promise<void>;
  list(): Promise<Repository[]>;
}

/** Кто смотрит список. Роль считает реализация, правило — эта функция. */
export interface InstallationAudience {
  viewer(telegramUserId: string): Promise<{ isRoot: boolean; leadsProject: boolean } | null>;
}

export interface ShowInstallationRepositories {
  telegramUserId: string;
  chat: string;
  idempotencyKey: string;
}

/** Порт для адаптера Telegram. Транзакция — у реализации. */
export interface InstallationRepositories {
  show(input: ShowInstallationRepositories): Promise<Repository[]>;
}

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/** id GitHub — непустое число без лидирующего нуля. */
export function githubRepositoryId(id: string): string {
  const trimmed = id.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_ID, 'id репозитория — id GitHub');
  }
  return trimmed;
}

/** Репозиторий установки: id GitHub, owner и name. */
export function defineRepository(input: { id: string; owner: string; name: string }): Repository {
  const id = githubRepositoryId(input.id);
  const owner = input.owner.trim();
  const name = input.name.trim();
  if (blank(owner)) throw new DomainError(DOMAIN_ERROR.REPOSITORY_OWNER_BLANK, 'у репозитория есть owner');
  if (blank(name)) throw new DomainError(DOMAIN_ERROR.REPOSITORY_NAME_BLANK, 'у репозитория есть name');
  return { id, owner, name };
}

/** Ключ зеркала — id репозитория. Проекта в нём нет. */
export function repositoryMirrorKey(repository: Repository): string {
  return repository.id;
}

/** Два просмотра видят один и тот же набор id. */
export function sameRepositoryMirror(left: readonly Repository[], right: readonly Repository[]): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map((item) => repositoryMirrorKey(item)));
  return right.every((item) => keys.has(repositoryMirrorKey(item)));
}

function compareRepository(left: Repository, right: Repository): number {
  if (left.owner < right.owner) return -1;
  if (left.owner > right.owner) return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function dedupe(repositories: readonly Repository[]): Repository[] {
  const byId = new Map<string, Repository>();
  for (const repository of repositories) byId.set(repositoryMirrorKey(repository), repository);
  return [...byId.values()].sort(compareRepository);
}

/**
 * GitHub App не настроен. Личный токен вместо него не подставляется.
 */
export function unconfiguredInstallationSource(): InstallationRepositorySource {
  return {
    async list(): Promise<readonly { id: string; owner: string; name: string }[]> {
      throw new DomainError(DOMAIN_ERROR.REPOSITORY_APP, 'GitHub подключён через GitHub App, не через личный токен');
    },
  };
}

/**
 * Показать репозитории установки GitHub App и записать их в зеркало.
 * Смотрит корень или руководитель, только в личке.
 * Повтор того же списка не создаёт второй строки: ключ — id репозитория.
 * Подключение к проекту этим актом не делается.
 */
export async function showInstallationRepositories(
  audience: InstallationAudience,
  source: InstallationRepositorySource,
  store: RepositoryStore,
  input: ShowInstallationRepositories,
): Promise<Repository[]> {
  if (input.chat !== PRIVATE_CHAT) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_CHAT, 'репозитории установки показываются в личке');
  }
  if (input.idempotencyKey.trim().length === 0) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_IDEMPOTENCY_KEY, 'ключ идемпотентности пуст');
  }
  const viewer = await audience.viewer(input.telegramUserId);
  if (viewer === null || (!viewer.isRoot && !viewer.leadsProject)) {
    throw new DomainError(DOMAIN_ERROR.REPOSITORY_ACCESS, 'репозитории установки показывает руководителю');
  }
  const listed = await source.list();
  const unique = dedupe(listed.map((item) => defineRepository(item)));
  for (const repository of unique) await store.upsert(repository);
  return unique;
}
