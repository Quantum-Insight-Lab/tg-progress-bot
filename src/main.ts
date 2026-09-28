import { systemClock } from './infrastructure/clock.ts';
import { getDb } from './infrastructure/db.ts';
import { readProcessConfig, startProcess } from './process.ts';

const running = await startProcess({ ...readProcessConfig(process.env, systemClock), db: getDb() });

function listen(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): void {
  process.on(signal, listener);
}

const stop = (): void => {
  void running.stop();
};

listen('SIGTERM', stop);
listen('SIGINT', stop);
