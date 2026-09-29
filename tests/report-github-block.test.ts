import { describe, expect, it } from 'vitest';
import { reportGithubBlock } from '../src/projections/report-github-block.ts';

const block = reportGithubBlock({
  slug: 'org/sensor',
  ci: 'success',
  mergedPullRequests: 1,
  commits: 6,
  projectNames: ['Общественный сенсор'],
});

describe('блок GitHub в отчёте', () => {
  it('R-684 «GitHub org/sensor»', () => {
    expect(block.startsWith('GitHub org/sensor\n')).toBe(true);
    expect(block).not.toContain('**');
  });

  it('R-377 CI', () => {
    expect(block).toContain('CI зелёный');
    expect(reportGithubBlock({ slug: 'org/sensor', ci: 'failure', mergedPullRequests: 0, commits: 0, projectNames: ['Сенсор'] })).toContain(
      'CI красный',
    );
    expect(reportGithubBlock({ slug: 'org/sensor', ci: 'cancelled', mergedPullRequests: 0, commits: 0, projectNames: ['Сенсор'] })).toContain(
      'CI отменён',
    );
    expect(reportGithubBlock({ slug: 'org/sensor', ci: 'other', mergedPullRequests: 0, commits: 0, projectNames: ['Сенсор'] })).toContain(
      'CI иной',
    );
    const unknown = reportGithubBlock({ slug: 'org/sensor', ci: null, mergedPullRequests: 1, commits: 6, projectNames: ['Сенсор'] });
    expect(unknown).toContain('Нет данных');
    expect(unknown).not.toContain('CI зелёный');
  });

  it('R-378 число смерженных PR', () => {
    expect(block).toContain('смержено PR 1');
    expect(block).not.toContain('#');
  });

  it('R-379 число коммитов', () => {
    expect(block).toContain('коммитов 6');
  });

  it('R-380 имена проектов этого репозитория', () => {
    expect(block).toContain('Проекты: Общественный сенсор');
    const shared = reportGithubBlock({
      slug: 'org/sensor',
      ci: 'success',
      mergedPullRequests: 1,
      commits: 6,
      projectNames: ['Общественный сенсор', 'Полевой архив'],
    });
    expect(shared).toContain('Проекты: Общественный сенсор, Полевой архив');
  });

  it('R-382 коммитов', () => {
    expect(block.split('\n')).toEqual([
      'GitHub org/sensor',
      'CI зелёный · смержено PR 1 · коммитов 6',
      'Проекты: Общественный сенсор',
    ]);
    expect(block).not.toMatch(/[0-9a-f]{7,40}/);
    expect(() =>
      reportGithubBlock({ slug: ' ', ci: 'success', mergedPullRequests: 1, commits: 6, projectNames: ['Сенсор'] }),
    ).toThrow('у блока репозитория есть имя');
    expect(() =>
      reportGithubBlock({ slug: 'org/sensor', ci: 'success', mergedPullRequests: 1, commits: 6, projectNames: [] }),
    ).toThrow('у блока GitHub есть проект');
    expect(() =>
      reportGithubBlock({ slug: 'org/sensor', ci: 'success', mergedPullRequests: -1, commits: 6, projectNames: ['Сенсор'] }),
    ).toThrow('счётчик блока GitHub — целое от нуля');
  });
});
