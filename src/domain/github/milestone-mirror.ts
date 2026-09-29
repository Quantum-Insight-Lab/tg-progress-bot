import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineMilestone, milestoneNaturalKey, type Milestone } from './milestone.ts';

/** Порт зеркала milestone внутри уже открытой транзакции. */
export interface MilestoneMirrorStore {
  find(repositoryId: string, milestoneNumber: number): Promise<Milestone | null>;
  save(milestone: Milestone): Promise<void>;
}

/**
 * Снимок milestone для зеркала репозитория.
 * Проекта в снимке нет: два проекта одного репозитория делят одну строку.
 */
export interface MilestoneMirrorFact {
  id: string;
  repositoryId: string;
  milestoneNumber: number;
  title: string;
  state: string;
  dueOn: string | null;
}

/**
 * Пишет milestone в зеркало по природному ключу.
 * Повтор того же репозитория и номера обновляет ту же строку и сохраняет её id.
 */
export async function saveMilestoneMirror(store: MilestoneMirrorStore, fact: MilestoneMirrorFact): Promise<Milestone> {
  const key = milestoneNaturalKey(fact.repositoryId, fact.milestoneNumber);
  const existing = await store.find(key.repositoryId, key.milestoneNumber);
  const milestone = defineMilestone({
    id: existing === null ? fact.id : existing.id,
    repositoryId: key.repositoryId,
    milestoneNumber: key.milestoneNumber,
    title: fact.title,
    state: fact.state,
    dueOn: fact.dueOn,
  });
  await store.save(milestone);
  const stored = await store.find(milestone.repositoryId, milestone.milestoneNumber);
  if (stored === null) throw new DomainError(DOMAIN_ERROR.MILESTONE_MIRROR, 'milestone не записан в зеркало');
  return stored;
}
