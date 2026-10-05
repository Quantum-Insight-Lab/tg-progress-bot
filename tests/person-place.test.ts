import { describe, expect, it } from 'vitest';
import {
  PERSON_PLACE_READ,
  PERSON_PLACE_ABSENT,
  PERSON_PLACE_SLICE,
  PERSON_PLACE_UNMATCHED,
  personBacklogPlace,
  placeChangesTaskStatus,
  type PersonBacklogIssue,
} from '../src/domain/progress/person-place.ts';
import { TASK_STATUS_DONE, TASK_STATUS_IN_PROGRESS, TASK_STATUSES } from '../src/domain/tasks/status.ts';
import { TASK_TRANSITION_CHECK, transitionTask } from '../src/domain/tasks/transition.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';

const repositoryId = '11';

function issue(
  issueNumber: number,
  state: 'open' | 'closed',
  stateReason: 'completed' | 'not_planned' | null,
  assignees: readonly string[],
): PersonBacklogIssue {
  return { repositoryId, issueNumber, state, stateReason, assignees };
}

const backlog: PersonBacklogIssue[] = [
  issue(1, 'closed', 'completed', ['Ann']),
  issue(2, 'closed', 'completed', ['boris']),
  issue(3, 'closed', 'not_planned', ['ann']),
  issue(4, 'open', null, ['ann', 'Boris']),
  issue(5, 'open', null, ['boris']),
  issue(6, 'open', null, []),
  issue(7, 'closed', 'completed', ['ann', 'boris']),
];

describe('место человека в бэклоге', () => {
  it('INV-14 место читается по issues: сделал — completed на нём, сейчас — открытые на нём, дальше — остальные открытые', () => {
    const place = personBacklogPlace('ann', repositoryId, [
      issue(1, 'closed', 'completed', ['Ann']),
      issue(2, 'closed', 'completed', ['boris']),
      issue(3, 'closed', 'not_planned', ['ann']),
      issue(4, 'open', null, ['ann', 'Boris']),
      issue(5, 'open', null, ['boris']),
      issue(6, 'open', null, []),
      issue(7, 'closed', 'completed', ['ann', 'boris']),
    ]);
    expect(place).toEqual({
      kind: PERSON_PLACE_SLICE,
      done: [1, 7],
      now: [4],
      next: [5, 6],
    });
    if (place.kind !== PERSON_PLACE_SLICE) return;
    expect([...place.done, ...place.now]).toEqual([1, 7, 4]);
  });

  it('INV-14 место не читается по задачам бота: закрытые задачи в «сделал» не входят', () => {
    const tasks = [
      { id: 't1', status: TASK_STATUS_DONE },
      { id: 't2', status: TASK_STATUS_DONE },
      { id: 't3', status: TASK_STATUS_DONE },
    ];
    const place = personBacklogPlace('ann', repositoryId, [issue(4, 'open', null, ['ann'])]);
    expect(place).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [4], next: [] });
    expect(tasks.map((task) => task.status)).toEqual([TASK_STATUS_DONE, TASK_STATUS_DONE, TASK_STATUS_DONE]);
    expect(place.kind === PERSON_PLACE_SLICE ? place.done : []).toEqual([]);
  });

  it('INV-14 issue относится к пользователю по текущему github_login среди assignees; старый логин не совпадает', () => {
    const issues = [issue(8, 'open', null, ['ann-old']), issue(9, 'open', null, ['Ann'])];
    const current = personBacklogPlace('ann', repositoryId, issues);
    const previous = personBacklogPlace('ann-old', repositoryId, issues);
    expect(current).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [9], next: [8] });
    expect(previous).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [8], next: [9] });
  });

  it('INV-14 без логина среза нет, задачи при этом переходят как обычно', () => {
    expect(personBacklogPlace(null, repositoryId, backlog)).toEqual({ kind: PERSON_PLACE_UNMATCHED });
    expect(personBacklogPlace('   ', repositoryId, backlog)).toEqual({ kind: PERSON_PLACE_UNMATCHED });
    expect(personBacklogPlace('ann', null, [])).toEqual({ kind: PERSON_PLACE_ABSENT });
    expect(personBacklogPlace(null, null, [])).toEqual({ kind: PERSON_PLACE_ABSENT });
    const move = transitionTask(TASK_STATUS_IN_PROGRESS, TASK_TRANSITION_CHECK);
    expect(move.from).toBe(TASK_STATUS_IN_PROGRESS);
    expect(move.to).toBe('REVIEW');
  });

  it('INV-14 один issue с несколькими assignees входит в «сейчас» каждого совпавшего', () => {
    const shared = [issue(4, 'open', null, ['ann', 'boris']), issue(5, 'open', null, ['vera'])];
    const ann = personBacklogPlace('ann', repositoryId, shared);
    const boris = personBacklogPlace('boris', repositoryId, shared);
    const vera = personBacklogPlace('vera', repositoryId, shared);
    expect(ann).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [4], next: [5] });
    expect(boris).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [4], next: [5] });
    expect(vera).toEqual({ kind: PERSON_PLACE_SLICE, done: [], now: [5], next: [4] });
  });

  it('INV-05 статус задачи не меняется, когда место человека читается по issues', () => {
    const before = [...TASK_STATUSES];
    const place = personBacklogPlace('ann', repositoryId, [
      issue(1, 'closed', 'completed', ['ann']),
      issue(4, 'open', null, ['ann']),
    ]);
    expect(place.kind).toBe(PERSON_PLACE_SLICE);
    expect(placeChangesTaskStatus()).toBe(false);
    for (const status of TASK_STATUSES) {
      expect(() => transitionTask(status, PERSON_PLACE_READ)).toThrowError(
        expect.objectContaining({ code: DOMAIN_ERROR.TASK_TRANSITION }),
      );
    }
    expect(TASK_STATUSES).toEqual(before);
  });
});
