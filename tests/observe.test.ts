import { describe, expect, it } from 'vitest';
import { GITHUB_RATE_FLOOR, MIRROR_LAG_INTERVALS, RECONCILE_INTERVAL } from '../src/config/constants.ts';
import { DOMAIN_ERROR } from '../src/domain/shared/errors.ts';
import {
  closedDayMissed,
  commandRejectionReason,
  mirrorIsStale,
  noDataShareWarrantsAlert,
  rateBelowFloor,
  telegramFailureKind,
} from '../src/domain/shared/observe.ts';
import { acceptRebuild } from '../src/domain/tasks/rebuild-canvas.ts';
import { duplicateNoticeKey, recordsDuplicate } from '../src/events/duplicate.ts';
import { EVENT_TYPES } from '../src/events/index.ts';
import { stabilityDashboard } from '../src/projections/stability.ts';

const MINUTE_MS = 60_000;

describe('наблюдаемость', () => {
  it('INV-22 повтор доставки замечается одним ключом и сам себя не плодит', () => {
    expect(duplicateNoticeKey('delivery-1')).toBe('duplicate:delivery-1');
    expect(recordsDuplicate(EVENT_TYPES.TASK_CREATED)).toBe(true);
    expect(recordsDuplicate(EVENT_TYPES.DELIVERY_DUPLICATE)).toBe(false);
  });

  it('INV-16 отказ своему участнику отделён от чужого и от заполненного канваса', () => {
    expect(commandRejectionReason(DOMAIN_ERROR.TASK_CONFIRM_ACTOR)).toBe('no_right');
    expect(commandRejectionReason(DOMAIN_ERROR.REBUILD_ROOT)).toBe('no_right');
    expect(commandRejectionReason(DOMAIN_ERROR.TASK_TRANSITION)).toBe('forbidden_transition');
    expect(commandRejectionReason(DOMAIN_ERROR.CANVAS_FULL)).toBeNull();
    expect(commandRejectionReason(DOMAIN_ERROR.TASK_TITLE_BLANK)).toBeNull();
  });

  it('INV-21 остаток лимита сравнивается с порогом и в GitHub не пишется', () => {
    expect(rateBelowFloor(GITHUB_RATE_FLOOR)).toBe(false);
    expect(rateBelowFloor(GITHUB_RATE_FLOOR - 1)).toBe(true);
  });

  it('INV-24 пропуск слота — только закрытые сутки, сбой доставки пропуском не является', () => {
    expect(closedDayMissed({ dayClosed: false, recorded: false, failed: false })).toBe(false);
    expect(closedDayMissed({ dayClosed: true, recorded: true, failed: false })).toBe(false);
    expect(closedDayMissed({ dayClosed: true, recorded: false, failed: true })).toBe(false);
    expect(closedDayMissed({ dayClosed: true, recorded: false, failed: false })).toBe(true);
  });

  it('INV-22 зеркало старше двух интервалов сверки — алерт M-8', () => {
    const interval = RECONCILE_INTERVAL * MINUTE_MS;
    expect(mirrorIsStale(interval * MIRROR_LAG_INTERVALS, interval)).toBe(false);
    expect(mirrorIsStale(interval * MIRROR_LAG_INTERVALS + 1, interval)).toBe(true);
    expect(noDataShareWarrantsAlert(0, 0)).toBe(false);
    expect(noDataShareWarrantsAlert(2, 1)).toBe(true);
  });

  it('INV-23 пересборка — сегодняшний канвас, INV-16 только корень в личке', () => {
    expect(() => acceptRebuild({ isRoot: false, privateChat: true, canvasDate: '2026-09-29', today: '2026-09-29' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REBUILD_ROOT }),
    );
    expect(() => acceptRebuild({ isRoot: true, privateChat: false, canvasDate: '2026-09-29', today: '2026-09-29' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REBUILD_CHAT }),
    );
    expect(() => acceptRebuild({ isRoot: true, privateChat: true, canvasDate: '2026-09-28', today: '2026-09-29' })).toThrow(
      expect.objectContaining({ code: DOMAIN_ERROR.REBUILD_DATE }),
    );
    expect(() => acceptRebuild({ isRoot: true, privateChat: true, canvasDate: '2026-09-29', today: '2026-09-29' })).not.toThrow();
  });

  it('INV-27 ошибка правки и лимит Telegram различаются', () => {
    expect(telegramFailureKind({ rateLimited: true, edit: true })).toBe('rate_limited');
    expect(telegramFailureKind({ rateLimited: false, edit: true })).toBe('edit_rejected');
    expect(telegramFailureKind({ rateLimited: false, edit: false })).toBe('other');
    expect(stabilityDashboard([{ metric: 'M-19', text: 'group' }])).toBe('Устойчивость\nM-19 group');
  });
});
