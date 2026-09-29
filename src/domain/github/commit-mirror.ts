import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { commitsInTail, defineCommit, type Commit } from './commit.ts';
import { githubRepositoryId } from './repository.ts';

/** Порт зеркала коммитов внутри уже открытой транзакции. */
export interface CommitMirrorStore {
  find(repositoryId: string, sha: string): Promise<Commit | null>;
  save(commit: Commit): Promise<void>;
  dropOutsideTail(repositoryId: string, now: Date): Promise<void>;
}

/**
 * Пишет хвост коммитов репозитория.
 * Повтор того же sha обновляет ту же строку и сохраняет её id.
 * Коммит старше окна не остаётся в таблице. Чужой репозиторий эта запись не трогает.
 */
export async function saveCommitTail(
  store: CommitMirrorStore,
  repositoryId: string,
  commits: readonly { sha: string; message: string; authorLogin: string; createdAt: string }[],
  now: Date,
  nextId: () => string,
): Promise<Commit[]> {
  const repository = githubRepositoryId(repositoryId);
  const kept = commitsInTail(
    commits.map((commit) => ({ ...commit, repositoryId: repository })),
    now,
  );
  const stored: Commit[] = [];
  const seen = new Set<string>();
  for (const fields of kept) {
    if (seen.has(fields.sha)) continue;
    seen.add(fields.sha);
    const existing = await store.find(fields.repositoryId, fields.sha);
    const commit = defineCommit({
      id: existing === null ? nextId() : existing.id,
      repositoryId: fields.repositoryId,
      sha: fields.sha,
      message: fields.message,
      authorLogin: fields.authorLogin,
      createdAt: fields.createdAt,
    });
    await store.save(commit);
    const row = await store.find(commit.repositoryId, commit.sha);
    if (row === null) throw new DomainError(DOMAIN_ERROR.COMMIT_MIRROR, 'коммит не записан в зеркало');
    stored.push(row);
  }
  await store.dropOutsideTail(repository, now);
  return stored;
}
