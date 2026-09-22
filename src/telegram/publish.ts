import { emit, hasIdempotencyKey, type EmitInput, type EventType } from "../events/index.js";

export function callbackQueryId(ctx: { callbackQuery?: { id: string } | undefined }): string | undefined {
  const id = ctx.callbackQuery?.id;
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  return id;
}

/** Кнопка: ключ — callback_query_id. Повтор не меняет состояние (INV-08). */
export async function commitFact<T extends EventType>(
  type: T,
  event: EmitInput<T>,
): Promise<boolean> {
  if (await hasIdempotencyKey(event.idempotencyKey)) {
    return false;
  }
  const sent = await emit(type, event);
  return sent.applied;
}
