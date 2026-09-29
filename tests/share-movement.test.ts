import { describe, expect, it } from 'vitest';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
} from '../src/domain/progress/backlog-share.ts';
import {
  BACKLOG_LIST_DONE,
  BACKLOG_LIST_IN_PROGRESS,
  BACKLOG_LIST_NEXT,
  dayAccounts,
  listedFromDay,
  listedFromRepository,
  projectShare,
  repositoryBacklog,
  SHARE_FACT_CHECKMARK,
  SHARE_FACT_DAY_TASK,
  SHARE_FACT_ISSUE_STATE,
  SHARE_FACT_MERGED_PULL_REQUEST,
  SHARE_FACT_TASK_CLOSED,
  SHARE_FACT_TASK_PRIORITY,
  shareAfter,
  type RepositoryIssue,
  type ShareFact,
} from '../src/domain/progress/share-movement.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';

const openIssue = (key: string, assignees: readonly string[] = []): RepositoryIssue => ({
  key,
  state: BACKLOG_ISSUE_OPEN,
  stateReason: null,
  assignees,
});

const completedIssue = (key: string, assignees: readonly string[] = []): RepositoryIssue => ({
  key,
  state: BACKLOG_ISSUE_CLOSED,
  stateReason: BACKLOG_ISSUE_COMPLETED,
  assignees,
});

describe('что долю не двигает', () => {
  it('INV-01 задачи процент не двигают', () => {
    const issues = [openIssue('1', ['anya']), completedIssue('2')];
    const before = projectShare(issues);
    const after = shareAfter(issues, [
      { kind: SHARE_FACT_DAY_TASK, status: 'IN_PROGRESS', checked: false, priority: 'normal' },
      { kind: SHARE_FACT_DAY_TASK, status: 'PLANNED', checked: false, priority: 'high' },
      { kind: SHARE_FACT_DAY_TASK, status: 'BLOCKED', checked: false, priority: 'low' },
      { kind: SHARE_FACT_DAY_TASK, status: 'REVIEW', checked: true, priority: 'normal' },
      { kind: SHARE_FACT_DAY_TASK, status: 'DONE', checked: true, priority: 'high' },
      { kind: SHARE_FACT_DAY_TASK, status: 'CANCELLED', checked: false, priority: 'low' },
    ]);
    expect(after).toEqual(before);
    expect(after).toEqual({ completed: 1, remaining: 1, ratio: 1 / 2 });
  });

  it('INV-01 процент и списки «Сделано / В работе / Далее» — issues репозитория', () => {
    const issues = [openIssue('4', ['anya']), completedIssue('9'), openIssue('51')];
    const day = { status: 'DONE', checked: true, priority: 'high' };
    const picture = repositoryBacklog(issues);
    expect(picture.lists).toEqual([BACKLOG_LIST_DONE, BACKLOG_LIST_IN_PROGRESS, BACKLOG_LIST_NEXT]);
    expect(picture.issues.map((issue) => issue.key)).toEqual(['4', '9', '51']);
    expect(picture.share).toEqual(projectShare(issues));
    const first = picture.issues[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(listedFromRepository(first)).toBe(true);
    expect(listedFromDay(day)).toBe(false);
    expect(shareAfter(issues, [{ kind: SHARE_FACT_DAY_TASK, ...day }])).toEqual(picture.share);
  });

  it('INV-01 закрытая задача процент не двигает', () => {
    const issues = [openIssue('1'), openIssue('2')];
    const before = projectShare(issues);
    expect(shareAfter(issues, [{ kind: SHARE_FACT_TASK_CLOSED }])).toEqual(before);
    expect(before).toEqual({ completed: 0, remaining: 2, ratio: 0 });
  });

  it('INV-01 галочка процент не двигает', () => {
    const issues = [completedIssue('1'), openIssue('2', ['boris'])];
    const before = projectShare(issues);
    expect(shareAfter(issues, [{ kind: SHARE_FACT_CHECKMARK }])).toEqual(before);
    expect(before.ratio).toBe(1 / 2);
  });

  it('INV-01 смерженный PR процент не двигает', () => {
    const issues = [openIssue('1'), completedIssue('2'), completedIssue('3')];
    const before = projectShare(issues);
    const after = shareAfter(issues, [
      { kind: SHARE_FACT_MERGED_PULL_REQUEST },
      { kind: SHARE_FACT_MERGED_PULL_REQUEST },
    ]);
    expect(after).toEqual(before);
    expect(after).toEqual({ completed: 2, remaining: 1, ratio: 2 / 3 });
  });

  it('INV-01 долю двигает смена состояния issue', () => {
    const issues = [openIssue('4', ['anya']), openIssue('5')];
    const before = projectShare(issues);
    const after = shareAfter(issues, [
      { kind: SHARE_FACT_TASK_CLOSED },
      { kind: SHARE_FACT_CHECKMARK },
      { kind: SHARE_FACT_MERGED_PULL_REQUEST },
      {
        kind: SHARE_FACT_ISSUE_STATE,
        key: '4',
        state: BACKLOG_ISSUE_CLOSED,
        stateReason: BACKLOG_ISSUE_COMPLETED,
      },
      { kind: SHARE_FACT_TASK_PRIORITY, priority: 'high' },
      {
        kind: SHARE_FACT_ISSUE_STATE,
        key: '5',
        state: BACKLOG_ISSUE_CLOSED,
        stateReason: BACKLOG_ISSUE_NOT_PLANNED,
      },
    ]);
    expect(before).toEqual({ completed: 0, remaining: 2, ratio: 0 });
    expect(after).toEqual({ completed: 1, remaining: 0, ratio: 1 });
    const onlyState = shareAfter(
      issues,
      [
        {
          kind: SHARE_FACT_ISSUE_STATE,
          key: '4',
          state: BACKLOG_ISSUE_CLOSED,
          stateReason: BACKLOG_ISSUE_COMPLETED,
        },
        {
          kind: SHARE_FACT_ISSUE_STATE,
          key: '5',
          state: BACKLOG_ISSUE_CLOSED,
          stateReason: BACKLOG_ISSUE_NOT_PLANNED,
        },
      ],
    );
    expect(after).toEqual(onlyState);
  });

  it('INV-01 приоритет в процент проекта не входит', () => {
    const issues = [openIssue('1'), completedIssue('2')];
    const low = shareAfter(issues, [{ kind: SHARE_FACT_TASK_PRIORITY, priority: 'low' }]);
    const high = shareAfter(issues, [{ kind: SHARE_FACT_TASK_PRIORITY, priority: 'high' }]);
    const normal = shareAfter(issues, [{ kind: SHARE_FACT_TASK_PRIORITY, priority: 'normal' }]);
    expect(low).toEqual(high);
    expect(high).toEqual(normal);
    expect(normal).toEqual(projectShare(issues));
  });

  it('INV-01 задачи остаются учётом дня и процент не подменяют', () => {
    const issues = [openIssue('1'), completedIssue('2')];
    const facts: ShareFact[] = [
      { kind: SHARE_FACT_DAY_TASK, status: 'DONE', checked: true, priority: 'high' },
      { kind: SHARE_FACT_DAY_TASK, status: 'IN_PROGRESS', checked: false, priority: 'normal' },
      { kind: SHARE_FACT_TASK_CLOSED },
      { kind: SHARE_FACT_MERGED_PULL_REQUEST },
    ];
    expect(dayAccounts(facts)).toEqual([
      { status: 'DONE', checked: true, priority: 'high' },
      { status: 'IN_PROGRESS', checked: false, priority: 'normal' },
    ]);
    expect(shareAfter(issues, facts)).toEqual(projectShare(issues));
    expect(repositoryBacklog(issues).issues).toHaveLength(2);
  });

  it('INV-01 процент проекта не делится по людям', () => {
    const issues = [openIssue('1', ['anya', 'boris']), completedIssue('2', ['anya'])];
    const share = projectShare(issues);
    expect(share).toEqual({ completed: 1, remaining: 1, ratio: 1 / 2 });
    expect(Object.keys(share).sort()).toEqual(['completed', 'ratio', 'remaining']);
    const anya = 1 / 2;
    const boris = 0;
    const meanOfPeople = (anya + boris) / 2;
    expect(share.ratio).not.toBe(meanOfPeople);
  });

  it('INV-01 issue с несколькими assignees входит в процент один раз', () => {
    const issue = openIssue('1', ['anya', 'boris']);
    const expanded = [openIssue('1', ['anya']), openIssue('1', ['boris']), completedIssue('2', ['anya'])];
    expect(projectShare(expanded)).toEqual(projectShare([issue, completedIssue('2', ['anya', 'boris'])]));
    expect(projectShare(expanded)).toEqual({ completed: 1, remaining: 1, ratio: 1 / 2 });
  });

  it('INV-01 последовательность задач, галочек, приоритетов и PR долю не меняет', () => {
    const issues = [
      openIssue('1', ['anya']),
      completedIssue('2'),
      {
        key: '3',
        state: BACKLOG_ISSUE_CLOSED,
        stateReason: BACKLOG_ISSUE_NOT_PLANNED,
        assignees: ['boris'],
      },
    ];
    const before = projectShare(issues);
    const statuses = ['PLANNED', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED', 'BLOCKED'];
    const priorities = ['normal', 'high', 'low'];
    const facts: ShareFact[] = [];
    for (const status of statuses) {
      for (const priority of priorities) {
        facts.push({ kind: SHARE_FACT_DAY_TASK, status, checked: false, priority });
        facts.push({ kind: SHARE_FACT_DAY_TASK, status, checked: true, priority });
        facts.push({ kind: SHARE_FACT_TASK_PRIORITY, priority });
      }
    }
    facts.push(
      { kind: SHARE_FACT_TASK_CLOSED },
      { kind: SHARE_FACT_CHECKMARK },
      { kind: SHARE_FACT_MERGED_PULL_REQUEST },
    );
    expect(shareAfter(issues, facts)).toEqual(before);
    expect(before).toEqual({ completed: 1, remaining: 1, ratio: 1 / 2 });
  });

  it('пустой ключ issue в процент не принимается', () => {
    expect(() => projectShare([openIssue('  ')])).toThrow(expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_ID_BLANK }));
  });
});
