import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { createScheduler, startSchedulerLoop, SYSTEM_ACTION_IDS, type SystemActionId } from '../src/infrastructure/scheduler.ts';

const moment = new Date('2026-09-28T00:00:00.000Z');
const clock: Clock = { now: () => moment };

describe('планировщик актов системы', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('слоты — ровно A-28…A-33, A-35 и A-36', () => {
    expect([...SYSTEM_ACTION_IDS]).toEqual(['A-28', 'A-29', 'A-30', 'A-31', 'A-32', 'A-33', 'A-35', 'A-36', 'A-42', 'A-44', 'A-45']);
  });

  it('без регистрации ход пустой', async () => {
    await expect(createScheduler(clock).run()).resolves.toEqual({ ran: [], failed: [] });
  });

  it('вызывает зарегистрированные акты одним моментом часов и не трогает пустые слоты', async () => {
    const scheduler = createScheduler(clock);
    const seen: { id: SystemActionId; time: number }[] = [];
    scheduler.register('A-36', async (now) => {
      seen.push({ id: 'A-36', time: now.getTime() });
    });
    scheduler.register('A-28', async (now) => {
      seen.push({ id: 'A-28', time: now.getTime() });
    });
    const result = await scheduler.run();
    expect(result.failed).toEqual([]);
    expect(result.ran).toEqual(['A-28', 'A-36']);
    expect(seen.map((item) => item.id)).toEqual(['A-28', 'A-36']);
    expect(seen.every((item) => item.time === moment.getTime())).toBe(true);
  });

  it('сбой одного акта не отменяет остальные', async () => {
    const scheduler = createScheduler(clock);
    const cause = new Error('boom');
    scheduler.register('A-28', async () => {
      throw cause;
    });
    scheduler.register('A-29', async () => undefined);
    const result = await scheduler.run();
    expect(result.ran).toEqual(['A-29']);
    expect(result.failed).toEqual([{ id: 'A-28', error: cause }]);
  });

  it('повторная регистрация и чужой id отклоняются', () => {
    const scheduler = createScheduler(clock);
    const action = async () => undefined;
    scheduler.register('A-32', action);
    expect(() => scheduler.register('A-32', action)).toThrow('действие A-32 уже зарегистрировано');
    expect(() => scheduler.register('A-34' as SystemActionId, action)).toThrow('неизвестное действие A-34');
  });

  it('ход по интервалу останавливается и не накладывается', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler(clock);
    let started = 0;
    let release: () => void = () => undefined;
    scheduler.register('A-32', () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const loop = startSchedulerLoop(scheduler, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(2);
    loop.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(started).toBe(2);
  });

  it('интервал меньше единицы не запускает цикл', () => {
    expect(() => startSchedulerLoop(createScheduler(clock), 0)).toThrow('интервал планировщика');
  });
});
