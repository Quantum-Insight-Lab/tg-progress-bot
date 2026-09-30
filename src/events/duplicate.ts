import { EVENT_TYPES, type EventType } from './generated/events.ts';

/** Ключ `delivery.duplicate`: один факт на исходный ключ (M-7, A-39). */
export function duplicateNoticeKey(sourceKey: string): string {
  return `duplicate:${sourceKey}`;
}

/** Повтор самого `delivery.duplicate` новое событие не порождает. */
export function recordsDuplicate(type: EventType): boolean {
  return type !== EVENT_TYPES.DELIVERY_DUPLICATE;
}
