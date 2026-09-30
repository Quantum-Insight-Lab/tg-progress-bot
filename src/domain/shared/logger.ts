/** Значение поля строки лога: ID, коды, числа. Текст людей сюда не передаётся. */
export type LogValue = string | number | boolean | null | readonly string[];

export type LogFields = Readonly<Record<string, LogValue>>;

/** Одна строка лога на шаг процесса. `cause` — отказ, из которого берётся причина. */
export type LogWrite = (step: string, fields?: LogFields, cause?: unknown) => void;

/**
 * Порт логгера для адаптеров, которые не импортируют инфраструктуру (S-1), как `Clock`.
 * Домен в лог не пишет: лог — шаги процесса, факты домена — журнал (INV-28).
 */
export interface Logger {
  debug: LogWrite;
  info: LogWrite;
  warn: LogWrite;
  error: LogWrite;
}
