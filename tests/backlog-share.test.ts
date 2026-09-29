import { describe, expect, it } from 'vitest';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
  backlogShare,
  type BacklogIssue,
  type BacklogShare,
} from '../src/domain/progress/backlog-share.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';

const openIssue: BacklogIssue = { state: BACKLOG_ISSUE_OPEN, stateReason: null };
const completedIssue: BacklogIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_COMPLETED };
const droppedIssue: BacklogIssue = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_NOT_PLANNED };

function copies(count: number, issue: BacklogIssue): BacklogIssue[] {
  return Array.from({ length: count }, () => issue);
}

describe('доля бэклога', () => {
  it('INV-01 прогресс = completed / (открытые + completed), остаток — открытые', () => {
    const share = backlogShare([
      ...copies(13, completedIssue),
      ...copies(18, openIssue),
      ...copies(4, droppedIssue),
    ]);
    expect(share.completed).toBe(13);
    expect(share.remaining).toBe(18);
    expect(share.ratio).toBe(13 / 31);
    expect(share.remaining + share.completed).toBe(31);
  });

  it('INV-01 в числителе только completed, открытый стоит в знаменателе', () => {
    expect(backlogShare([completedIssue])).toEqual<BacklogShare>({
      completed: 1,
      remaining: 0,
      ratio: 1,
    });
    expect(backlogShare([openIssue])).toEqual<BacklogShare>({
      completed: 0,
      remaining: 1,
      ratio: 0,
    });
    expect(backlogShare([completedIssue, openIssue, openIssue])).toEqual<BacklogShare>({
      completed: 1,
      remaining: 2,
      ratio: 1 / 3,
    });
  });

  it('INV-01 not_planned не стоит ни в числителе, ни в знаменателе', () => {
    const without = backlogShare([completedIssue, openIssue]);
    const withDropped = backlogShare([completedIssue, openIssue, droppedIssue, droppedIssue]);
    expect(withDropped).toEqual(without);
    expect(backlogShare([droppedIssue])).toEqual<BacklogShare>({
      completed: 0,
      remaining: 0,
      ratio: null,
    });
    expect(backlogShare([])).toEqual<BacklogShare>({
      completed: 0,
      remaining: 0,
      ratio: null,
    });
  });

  it('INV-01 каждый issue весит одинаково, размер работы не оценивается', () => {
    const heavy = { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_COMPLETED, size: 100 };
    const light = { state: BACKLOG_ISSUE_OPEN, stateReason: null, size: 1 };
    const share = backlogShare([heavy, light]);
    expect(share).toEqual<BacklogShare>({ completed: 1, remaining: 1, ratio: 1 / 2 });
  });

  it('INV-01 открытый issue стоит в знаменателе, кем бы он ни был назначен', () => {
    const unassigned = { state: BACKLOG_ISSUE_OPEN, stateReason: null, assignees: [] as string[] };
    const one = { state: BACKLOG_ISSUE_OPEN, stateReason: null, assignees: ['anya'] };
    const several = { state: BACKLOG_ISSUE_OPEN, stateReason: null, assignees: ['anya', 'boris'] };
    const share = backlogShare([unassigned, one, several]);
    expect(share.completed).toBe(0);
    expect(share.remaining).toBe(3);
    expect(share.ratio).toBe(0);
  });

  it('INV-01 линейка — список issues, а не задачи, заведённые за день', () => {
    const openBesideDoneTask = {
      state: BACKLOG_ISSUE_OPEN,
      stateReason: null,
      taskStatus: 'DONE',
      checked: true,
    };
    expect(backlogShare([openBesideDoneTask, completedIssue])).toEqual<BacklogShare>({
      completed: 1,
      remaining: 1,
      ratio: 1 / 2,
    });
  });

  it('битое состояние issue в формулу не попадает', () => {
    expect(() => backlogShare([{ state: 'DONE', stateReason: null }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE }),
    );
    expect(() => backlogShare([{ state: BACKLOG_ISSUE_OPEN, stateReason: BACKLOG_ISSUE_COMPLETED }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
    expect(() => backlogShare([{ state: BACKLOG_ISSUE_CLOSED, stateReason: null }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
    expect(() => backlogShare([{ state: BACKLOG_ISSUE_CLOSED, stateReason: 'wontfix' }])).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.ISSUE_STATE_REASON }),
    );
  });
});
