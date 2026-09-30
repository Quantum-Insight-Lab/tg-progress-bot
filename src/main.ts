import { systemClock } from './infrastructure/clock.ts';
import { getDb } from './infrastructure/db.ts';
import { readProcessConfig, startProcess } from './process.ts';

const running = await startProcess({ ...readProcessConfig(process.env, systemClock), db: getDb() });

function listen(signal: NodeJS.Signals, listener: NodeJS.SignalsListener): void {
  process.on(signal, listener);
}

const stop = (signal: NodeJS.Signals): void => {
  running.stop(signal).catch(() => {
    process.exitCode = 1;
  });
};

listen('SIGTERM', stop);
listen('SIGINT', stop);
