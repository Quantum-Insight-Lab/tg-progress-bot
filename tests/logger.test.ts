import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../src/domain/shared/clock.ts';
import { createLogger, createProcessLogger, LOG_LEVELS, readLogLevel, secretValues } from '../src/infrastructure/logger.ts';
import { captureLog } from './log-lines.ts';

const moment = new Date('2026-09-30T12:00:00.000Z');
const clock: Clock = { now: () => moment };

const BOT_TOKEN = '100200:log-test-bot-token-value';
const TELEGRAM_SECRET = 'log-test-telegram-webhook-secret';
const GITHUB_SECRET = 'log-test-github-webhook-secret';
const KEY_LINE_ONE = 'MIIEpAIBAAKCAQEAlogTestPrivateKeyLineOne';
const KEY_LINE_TWO = 'logTestPrivateKeyLineTwoAbCdEf0123';
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\\n${KEY_LINE_ONE}\\n${KEY_LINE_TWO}\\n-----END RSA PRIVATE KEY-----`;
const DB_SECRET = 'log-test-db-secret@x';
const DB_SECRET_ENCODED = 'log-test-db-secret%40x';

const secretEnv: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
  GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
  GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY,
  DATABASE_URL: `postgres://user:${DB_SECRET_ENCODED}@localhost:5432/botdb`,
};

const SECRET_SUBSTRINGS = [
  BOT_TOKEN,
  TELEGRAM_SECRET,
  GITHUB_SECRET,
  PRIVATE_KEY,
  PRIVATE_KEY.replaceAll('\\n', '\n'),
  KEY_LINE_ONE,
  KEY_LINE_TWO,
  DB_SECRET,
  DB_SECRET_ENCODED,
];

function expectNoSecrets(raw: readonly string[]): void {
  const output = raw.join('\n');
  for (const secret of SECRET_SUBSTRINGS) expect(output).not.toContain(secret);
}

describe('B-17 логгер: уровень и запись', () => {
  it('уровень — LOG_LEVEL, по умолчанию info, неизвестное значение — отказ старта', () => {
    expect(readLogLevel({})).toBe('info');
    expect(readLogLevel({ LOG_LEVEL: '' })).toBe('info');
    for (const level of LOG_LEVELS) expect(readLogLevel({ LOG_LEVEL: level })).toBe(level);
    expect(() => readLogLevel({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL — одно из debug, info, warn, error');
  });

  it('строка — один JSON: время ISO по Clock, уровень, шаг, поля; ниже уровня не пишется', () => {
    const log = captureLog({ level: 'info', clock });
    log.logger.debug('step.debug', { value: 1 });
    log.logger.info('step.info', { count: 2, ids: ['A-28'], flag: true, empty: null });
    log.logger.warn('step.warn');
    log.logger.error('step.error', { level: 'debug', slot: 'A-30' }, new Error('причина\nвторая строка'));
    expect(log.raw).toHaveLength(3);
    for (const line of log.raw) expect(line).not.toContain('\n');
    expect(log.lines()).toEqual([
      { time: '2026-09-30T12:00:00.000Z', level: 'info', step: 'step.info', count: 2, ids: ['A-28'], flag: true, empty: null },
      { time: '2026-09-30T12:00:00.000Z', level: 'warn', step: 'step.warn' },
      { time: '2026-09-30T12:00:00.000Z', level: 'error', step: 'step.error', slot: 'A-30', reason: 'причина\nвторая строка' },
    ]);
    const quiet = captureLog({ level: 'error', clock });
    quiet.logger.info('step.info');
    quiet.logger.warn('step.warn');
    quiet.logger.error('step.error');
    expect(quiet.lines().map((line) => line.level)).toEqual(['error']);
  });

  it('значение секрета из окружения в выводе не встречается', () => {
    const raw: string[] = [];
    const logger = createLogger({ level: 'debug', clock, secrets: secretValues(secretEnv), write: (line) => raw.push(line) });
    for (const secret of SECRET_SUBSTRINGS) {
      logger.debug('secret.field', { value: `до ${secret} после`, list: [secret] });
      logger.error('secret.cause', {}, new Error(`https://api.telegram.org/bot${secret}/getMe`));
      logger.warn(`secret.step ${secret}`, {}, secret);
    }
    expect(raw).toHaveLength(SECRET_SUBSTRINGS.length * 3);
    expectNoSecrets(raw);
    expect(raw.join('\n')).toContain('до [скрыто] после');
    expect(secretValues({})).toEqual([]);
    expect(secretValues({ DATABASE_URL: 'postgres://localhost/botdb' })).toEqual([]);
  });

  it('логгер процесса пишет в stdout с уровнем и секретами из окружения', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const logger = createProcessLogger({ ...secretEnv, LOG_LEVEL: 'warn' }, clock);
      logger.info('process.info');
      logger.warn('process.warn', { token: BOT_TOKEN });
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(written[0] ?? '')).toEqual({ time: moment.toISOString(), level: 'warn', step: 'process.warn', token: '[скрыто]' });
    expectNoSecrets(written);
  });
});
