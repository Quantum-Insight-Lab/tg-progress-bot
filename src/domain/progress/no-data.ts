import type { BacklogShare } from './backlog-share.ts';

/**
 * Процент проекта.
 * Нет репозитория или пустой знаменатель — числа нет. Это не ноль.
 * Известная доля, в том числе ноль при открытых issues, остаётся числом.
 * Задачи, канвас и блокеры по тишине в аргумент не входят: они процент не создают.
 */
export function projectShareRatio(share: BacklogShare | null): number | null {
  if (share === null) return null;
  return share.ratio;
}
