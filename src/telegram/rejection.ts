import { DomainError } from '../domain/shared/errors.ts';

/** Журнал отказа. Процесс подставляет реализацию, тесты могут не подключать. */
export interface RejectionNote {
  note(error: DomainError, idempotencyKey: string, telegramUserId: string): Promise<void>;
}

let note: RejectionNote | null = null;

export function bindRejectionNote(next: RejectionNote | null): void {
  note = next;
}

/** A-38. Сбой записи не прячет отказ от человека. */
export async function noteCommandRejection(error: unknown, idempotencyKey: string, telegramUserId: string): Promise<void> {
  if (note === null || !(error instanceof DomainError)) return;
  try {
    await note.note(error, idempotencyKey, telegramUserId);
  } catch {
    return;
  }
}
