import type { CanvasParagraph } from './canvas-message.ts';

/**
 * P-9. Строка GitHub на канвасе — один абзац.
 * Репозиторий, CI основной ветки, число открытых PR, коммиты за сутки,
 * ближайший открытый milestone со сроком.
 * Пустой CI словами этой строки не заменяется. Полный список PR не печатается.
 */

/** Известный статус CI основной ветки. Пусто — ещё неизвестен. */
export type GithubLineCi = 'success' | 'failure' | 'cancelled' | 'other' | null;

/** Milestone строки: название и срок `YYYY-MM-DD`. */
export interface GithubLineMilestone {
  title: string;
  dueOn: string;
}

/** Факты, которые строка печатает. Отбор — в домене. */
export interface GithubLineView {
  owner: string;
  name: string;
  ci: GithubLineCi;
  openPullRequests: number;
  commitsOnDay: number;
  milestone: GithubLineMilestone | null;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function countText(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error('счётчик строки GitHub — целое число');
  return String(value);
}

function dayMonth(iso: string): string {
  const match = CALENDAR_DATE.exec(iso.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('срок milestone — календарный день');
  return `${day}.${month}`;
}

function ciText(ci: GithubLineCi): string | null {
  switch (ci) {
    case null:
      return null;
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

/** Текст одной строки. Репозиторий — `owner/name`, части через « · ». */
export function githubLineText(line: GithubLineView): string {
  const owner = line.owner.trim();
  const name = line.name.trim();
  if (owner.length === 0 || name.length === 0) throw new Error('у строки GitHub есть репозиторий');
  const parts: string[] = [];
  const ci = ciText(line.ci);
  if (ci !== null) parts.push(ci);
  parts.push(`открытых PR ${countText(line.openPullRequests)}`);
  parts.push(`коммитов за сутки ${countText(line.commitsOnDay)}`);
  if (line.milestone !== null) {
    const title = line.milestone.title.trim();
    if (title.length === 0) throw new Error('у milestone строки GitHub есть название');
    parts.push(`milestone ${title} до ${dayMonth(line.milestone.dueOn)}`);
  }
  return `GitHub ${owner}/${name}: ${parts.join(' · ')}`;
}

/** Один абзац канваса. Пустой репозиторий сюда не передаётся. */
export function githubLineParagraphs(line: GithubLineView): CanvasParagraph[] {
  return [{ pieces: [{ kind: 'text', text: githubLineText(line) }] }];
}
