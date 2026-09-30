import type { Clock } from '../domain/shared/clock.ts';
import type { Logger } from '../domain/shared/logger.ts';

/**
 * Акты системы, для которых планировщик держит слот (поток «Время» в архитектуре).
 * Сами действия приходят в своих issues и регистрируются здесь. A-34 слота не имеет:
 * отказ постороннему — ответ на сообщение, не ход планировщика.
 * A-37…A-41 и A-43 тоже без слота: команда или момент отказа.
 */
export const SYSTEM_ACTION_IDS = ['A-28', 'A-29', 'A-30', 'A-31', 'A-32', 'A-33', 'A-35', 'A-36', 'A-42', 'A-44', 'A-45'] as const;

export type SystemActionId = (typeof SYSTEM_ACTION_IDS)[number];

export type SystemAction = (now: Date) => Promise<void>;

export interface SchedulerFailure {
  id: SystemActionId;
  error: unknown;
}

export interface SchedulerRun {
  ran: readonly SystemActionId[];
  failed: readonly SchedulerFailure[];
}

export interface Scheduler {
  register(id: SystemActionId, action: SystemAction): void;
  run(): Promise<SchedulerRun>;
}

function isSystemActionId(id: string): id is SystemActionId {
  return (SYSTEM_ACTION_IDS as readonly string[]).includes(id);
}

/** Слоты актов системы. Время хода — `Clock`, не часы сервера. */
export function createScheduler(clock: Clock): Scheduler {
  const actions = new Map<SystemActionId, SystemAction>();
  return {
    register(id, action) {
      if (!isSystemActionId(id)) throw new Error(`неизвестное действие ${id}`);
      if (actions.has(id)) throw new Error(`действие ${id} уже зарегистрировано`);
      actions.set(id, action);
    },
    async run() {
      const now = clock.now();
      const ran: SystemActionId[] = [];
      const failed: SchedulerFailure[] = [];
      for (const id of SYSTEM_ACTION_IDS) {
        const action = actions.get(id);
        if (action === undefined) continue;
        try {
          await action(now);
          ran.push(id);
        } catch (error) {
          failed.push({ id, error });
        }
      }
      return { ran, failed };
    },
  };
}

function logRun(logger: Logger, run: SchedulerRun): void {
  logger.info('scheduler.run', { ran: run.ran, failed: run.failed.map((failure) => failure.id) });
  for (const failure of run.failed) logger.error('scheduler.slot_failed', { slot: failure.id }, failure.error);
}

/**
 * Периодический ход. Интервал — параметр процесса, не порог домена.
 * Пока предыдущий ход не закончился, следующий не стартует.
 */
export function startSchedulerLoop(scheduler: Scheduler, intervalMs: number, logger: Logger): { stop(): void } {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('интервал планировщика');
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (busy) {
      logger.debug('scheduler.tick_skipped');
      return;
    }
    busy = true;
    void scheduler.run().then(
      (run) => {
        busy = false;
        logRun(logger, run);
      },
      (error: unknown) => {
        busy = false;
        logger.error('scheduler.run_failed', {}, error);
      },
    );
  }, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
