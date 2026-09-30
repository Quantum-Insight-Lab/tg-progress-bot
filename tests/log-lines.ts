import type { Clock } from '../src/domain/shared/clock.ts';
import type { Logger } from '../src/domain/shared/logger.ts';
import { createLogger, type LogLevel } from '../src/infrastructure/logger.ts';

export type LogLine = Record<string, unknown>;

export interface CapturedLog {
  logger: Logger;
  /** Строки как они ушли бы в stdout. */
  raw: string[];
  lines(): LogLine[];
  steps(step: string): LogLine[];
}

const fixedClock: Clock = { now: () => new Date('2026-09-30T12:00:00.000Z') };

export function captureLog(options: { level?: LogLevel; clock?: Clock; secrets?: readonly string[] } = {}): CapturedLog {
  const raw: string[] = [];
  const logger = createLogger({
    level: options.level ?? 'debug',
    clock: options.clock ?? fixedClock,
    secrets: options.secrets ?? [],
    write: (line) => {
      raw.push(line);
    },
  });
  const lines = (): LogLine[] => raw.map((line) => JSON.parse(line) as LogLine);
  return { logger, raw, lines, steps: (step) => lines().filter((line) => line.step === step) };
}
