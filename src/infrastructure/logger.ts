import type { Clock } from '../domain/shared/clock.ts';
import type { LogFields, Logger, LogValue } from '../domain/shared/logger.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

const REDACTED = '[скрыто]';

/** Переменные окружения, значения которых не попадают в запись. Пароль БД — из `DATABASE_URL`. */
const SECRET_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY'] as const;

const PEM_BOUNDARY = '-----';

export interface LoggerOptions {
  level: LogLevel;
  clock: Clock;
  secrets: readonly string[];
  /** Куда уходит строка. По умолчанию — stdout процесса. */
  write?: (line: string) => void;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Уровень из `LOG_LEVEL`. Пусто — `info`; неизвестное значение останавливает старт. */
export function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.LOG_LEVEL?.trim() ?? '';
  if (raw.length === 0) return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(raw)) throw new Error(`LOG_LEVEL — одно из ${LOG_LEVELS.join(', ')}`);
  return raw;
}

function decoded(value: string): string[] {
  try {
    return [decodeURIComponent(value)];
  } catch {
    return [];
  }
}

function databaseUrlSecret(url: string | undefined): string[] {
  if (url === undefined || !URL.canParse(url.trim())) return [];
  const secret = new URL(url.trim()).password; // pragma: allowlist secret
  if (secret.length === 0) return [];
  return [secret, ...decoded(secret)];
}

/** Ключ App хранится с `\n` в одну строку; в ошибке он может оказаться уже разобранным по строкам. */
function privateKeyForms(value: string): string[] {
  const normalized = value.replaceAll('\\n', '\n').trim();
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(PEM_BOUNDARY));
  return [normalized, ...lines];
}

/** Значения секретов из окружения, которые логгер вырезает из каждой записи. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const name of SECRET_ENV) {
    const value = env[name];
    if (value === undefined) continue;
    found.push(value, value.trim());
    if (name === 'GITHUB_APP_PRIVATE_KEY') found.push(...privateKeyForms(value));
  }
  found.push(...databaseUrlSecret(env.DATABASE_URL));
  const unique = [...new Set(found.filter((value) => value.length > 0))];
  return unique.sort((left, right) => right.length - left.length);
}

function redact(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) clean = clean.replaceAll(secret, REDACTED);
  return clean;
}

function redactValue(value: LogValue, secrets: readonly string[]): LogValue {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item: string) => redact(item, secrets));
  return value;
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message.length > 0 ? cause.message : cause.name;
  return String(cause);
}

function stdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Логгер процесса: одна строка JSON на шаг — время ISO, уровень, шаг, поля. */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const write = options.write ?? stdout;
  const at = (level: LogLevel) => (step: string, fields: LogFields = {}, cause?: unknown) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const record: Record<string, LogValue> = {
      time: options.clock.now().toISOString(),
      level,
      step: redact(step, options.secrets),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (key in record) continue;
      record[key] = redactValue(value, options.secrets);
    }
    if (cause !== undefined) record.reason = redact(reasonOf(cause), options.secrets);
    write(JSON.stringify(record));
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Один логгер на процесс: уровень и секреты — из окружения. */
export function createProcessLogger(env: NodeJS.ProcessEnv, clock: Clock): Logger {
  return createLogger({ level: readLogLevel(env), clock, secrets: secretValues(env) });
}
