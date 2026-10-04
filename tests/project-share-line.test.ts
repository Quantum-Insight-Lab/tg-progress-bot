import { describe, expect, it } from 'vitest';
import { backlogShare } from '../src/domain/progress/backlog-share.ts';
import {
  overallBacklogShare,
  projectRepositoryReadings,
  type IssueRow,
  type ProjectMemberSlice,
} from '../src/domain/progress/repository-share.ts';
import { NO_DATA_SHARE, backlogShareParagraphs, projectShareParagraphs } from '../src/projections/backlog-line.ts';
import { renderCanvas, type CanvasRichMessage, type CanvasRichText } from '../src/projections/canvas-message.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';

const repoA = '11';
const repoB = '22';
const outsider = '99';

const open = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'open',
  stateReason: null,
});

const completed = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'closed',
  stateReason: 'completed',
});

const dropped = (repositoryId: string, issueNumber: number): IssueRow => ({
  repositoryId,
  issueNumber,
  state: 'closed',
  stateReason: 'not_planned',
});

function fill(repositoryId: string, kind: 'open' | 'completed', count: number, from: number): IssueRow[] {
  const rows: IssueRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = from + index;
    rows.push(kind === 'open' ? open(repositoryId, number) : completed(repositoryId, number));
  }
  return rows;
}

const mockIssues = [...fill(repoA, 'completed', 13, 1), ...fill(repoA, 'open', 18, 14)];

const projectA: ProjectMemberSlice = {
  projectId: 'alpha',
  repositoryId: repoA,
  memberKeys: ['pull_request:8'],
};

const projectATwin: ProjectMemberSlice = {
  projectId: 'beta',
  repositoryId: repoA,
  memberKeys: ['commit:abc'],
};

const projectB: ProjectMemberSlice = {
  projectId: 'gamma',
  repositoryId: repoB,
  memberKeys: [],
};

const bare: ProjectMemberSlice = {
  projectId: 'delta',
  repositoryId: null,
  memberKeys: [],
};

const half = [completed(repoA, 1), open(repoA, 2)];
const quarter = [completed(repoB, 1), open(repoB, 2), open(repoB, 3), open(repoB, 4)];

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.map((block) => visible(block.text));
}

function painted(share: ReturnType<typeof backlogShare> | null): string[] {
  const prepared = prepareCanvasMessage({
    projectName: 'Общественный сенсор',
    canvasDate: '2026-09-17',
    sections: { backlog: backlogShareParagraphs(share) },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  return linesOf(prepared.message);
}

describe('строка доли и общий процент', () => {
  it('R-975 доля — полоска из десяти клеток', () => {
    const lines = painted(backlogShare(mockIssues));
    expect(lines[1]?.startsWith('████░░░░░░ ')).toBe(true);
    expect(lines[1]).toContain('Сделано по проекту: 42%');
  });

  it('R-109 «Сделано по проекту: 42%»', () => {
    const lines = painted(backlogShare(mockIssues));
    expect(lines[1]).toBe('████░░░░░░ Сделано по проекту: 42% · осталось 18 из 31');
    expect(lines[1]).toContain('Сделано по проекту: 42%');
  });

  it('R-110 «осталось 18 из 31»', () => {
    const lines = painted(backlogShare(mockIssues));
    expect(lines[1]).toContain('осталось 18 из 31');
  });

  it('R-175 у проектов одного репозитория на канвасе одна доля', () => {
    const readings = projectRepositoryReadings([projectA, projectATwin], mockIssues);
    const first = projectShareParagraphs(readings[0]?.share ?? null);
    const second = projectShareParagraphs(readings[1]?.share ?? null);
    expect(first).toEqual(second);
    expect(linesOf(renderCanvas({
      projectName: 'Альфа',
      canvasDate: '2026-09-17',
      sections: { backlog: first },
    }))[1]).toBe(linesOf(renderCanvas({
      projectName: 'Бета',
      canvasDate: '2026-09-17',
      sections: { backlog: second },
    }))[1]);
  });

  it('R-445 остаток всегда рядом с процентом', () => {
    const paragraphs = projectShareParagraphs(backlogShare(mockIssues));
    expect(paragraphs).toHaveLength(1);
    const text = paragraphs[0]?.pieces[0];
    expect(text).toEqual({ kind: 'text', text: '████░░░░░░ Сделано по проекту: 42% · осталось 18 из 31' });
    const full = projectShareParagraphs(backlogShare(fill(repoA, 'completed', 13, 1)));
    const fullText = full[0]?.pieces[0];
    expect(fullText?.kind).toBe('text');
    if (fullText?.kind === 'text') expect(fullText.text).toBe('██████████ Сделано по проекту: 100% · осталось 0 из 13');
  });

  it('INV-01 делёж issues одного репозитория по проектам в формулу не входит', () => {
    const readings = projectRepositoryReadings([projectA, projectATwin], mockIssues);
    const whole = backlogShare(mockIssues);
    expect(readings[0]?.share).toEqual(whole);
    expect(readings[1]?.share).toEqual(whole);
    expect(readings[0]?.share).not.toEqual(backlogShare([mockIssues[0] ?? open(repoA, 1)]));
    expect(projectShareParagraphs(readings[0]?.share ?? null)).toEqual(projectShareParagraphs(whole));
    const withDropped = [...mockIssues, dropped(repoA, 100)];
    expect(projectShareParagraphs(backlogShare(withDropped))[0]).toEqual(projectShareParagraphs(whole)[0]);
  });

  it('INV-01 общий процент — та же формула по репозиториям, каждый один раз', () => {
    const issues = [...half, ...quarter];
    const once = overallBacklogShare([projectA, projectB], issues);
    const repeated = overallBacklogShare([projectA, projectATwin, projectB], issues);
    expect(once).toEqual(backlogShare(issues));
    expect(repeated).toEqual(once);
    expect(repeated.completed).toBe(2);
    expect(repeated.remaining).toBe(4);
    expect(overallBacklogShare([projectA], [...half, completed(outsider, 1)])).toEqual(backlogShare(half));
  });

  it('INV-01 проект без репозитория в общую цифру не входит', () => {
    const issues = [...half, ...quarter];
    expect(overallBacklogShare([projectA, projectB, bare], issues)).toEqual(
      overallBacklogShare([projectA, projectB], issues),
    );
    expect(overallBacklogShare([bare], issues)).toEqual(backlogShare([]));
  });

  it('INV-01 общий процент — не среднее арифметическое карточек', () => {
    const issues = [...half, ...quarter];
    const share = overallBacklogShare([projectA, projectATwin, projectB], issues);
    const meanOfCards = (1 / 2 + 1 / 2 + 1 / 4) / 3;
    expect(share).toEqual(backlogShare(issues));
    expect(share.ratio).toBe(2 / 6);
    expect(share.ratio).not.toBe(meanOfCards);
    expect(share.ratio).not.toBe((1 / 2 + 1 / 4) / 2);
  });

  it('INV-01 известный ноль печатает процент и остаток', () => {
    const share = backlogShare([open(repoA, 1), open(repoA, 2)]);
    const lines = painted(share);
    expect(lines[1]).toBe('░░░░░░░░░░ Сделано по проекту: 0% · осталось 2 из 2');
    expect(lines.join('\n')).not.toContain(NO_DATA_SHARE);
    expect(backlogShareParagraphs(null).map((paragraph) => paragraph.pieces[0])).toEqual([
      { kind: 'text', text: `░░░░░░░░░░ ${NO_DATA_SHARE}` },
    ]);
  });
});
