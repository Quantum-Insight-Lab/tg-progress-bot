import type { Clock } from '../domain/shared/clock.ts';

/** Единственное место, где читается системное время (S-10). */
export const systemClock: Clock = { now: () => new Date() };
