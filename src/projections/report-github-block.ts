/**
 * P-14. Блок GitHub в отчёте.
 * Репозиторий, CI, число смерженных PR, число коммитов, имена проектов этого репозитория.
 * Названия issues и список коммитов сюда не входят: в тексте только числа репозитория.
 * Пустой CI — «Нет данных», не выдуманный статус.
 */

/** Промежуток между фактами, как в макете отчёта. */
const REPORT_GITHUB_GAP = ' · ';

/** CI ещё неизвестен. На строке это слово, не статус. */
const REPORT_GITHUB_NO_DATA = 'Нет данных';

/** Известный статус CI репозитория. Пусто — ещё неизвестен. */
export type ReportGithubCi = 'success' | 'failure' | 'cancelled' | 'other' | null;

/** Факты одного блока. Отбор чисел — снаружи, здесь только печать. */
export interface ReportGithubBlockView {
  slug: string;
  ci: ReportGithubCi;
  mergedPullRequests: number;
  commits: number;
  projectNames: readonly string[];
}

function countText(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error('счётчик блока GitHub — целое от нуля');
  return String(value);
}

function ciText(ci: ReportGithubCi): string {
  switch (ci) {
    case null:
      return REPORT_GITHUB_NO_DATA;
    case 'success':
      return 'CI зелёный';
    case 'failure':
      return 'CI красный';
    case 'cancelled':
      return 'CI отменён';
    case 'other':
      return 'CI иной';
    default: {
      const unexpected: never = ci;
      throw new Error(`статус CI не печатается: ${String(unexpected)}`);
    }
  }
}

/**
 * Три строки блока: «GitHub owner/name», факты, «Проекты: …».
 * Список коммитов и названия issues в эти строки не подмешиваются.
 */
export function reportGithubBlock(view: ReportGithubBlockView): string {
  const slug = view.slug.trim();
  if (slug.length === 0) throw new Error('у блока репозитория есть имя');
  const names = view.projectNames.map((value) => {
    const name = value.trim();
    if (name.length === 0) throw new Error('у блока проекта есть имя');
    return name;
  });
  if (names.length === 0) throw new Error('у блока GitHub есть проект');
  const facts = [
    ciText(view.ci),
    `смержено PR ${countText(view.mergedPullRequests)}`,
    `коммитов ${countText(view.commits)}`,
  ].join(REPORT_GITHUB_GAP);
  return [`GitHub ${slug}`, facts, `Проекты: ${names.join(', ')}`].join('\n');
}
