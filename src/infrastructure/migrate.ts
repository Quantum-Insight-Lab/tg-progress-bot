import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Миграция журнала: поля таблицы и constraint'ы, не проверка в хендлере. */
export function readEventsMigration(root = process.cwd()): string {
  return readFileSync(join(root, 'migrations', '001_events.sql'), 'utf8');
}
