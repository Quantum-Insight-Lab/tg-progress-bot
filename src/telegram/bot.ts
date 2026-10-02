import { Bot, type BotConfig, type Context, type Transformer } from 'grammy';

/** Сведения о боте из `getMe`. Если переданы при создании, повторный `getMe` не нужен. */
export type TelegramBotInfo = NonNullable<BotConfig<Context>['botInfo']>;

/** Новое сообщение в чат. Правка канваса сюда не входит: она звука не даёт. */
const GROUP_SENDS = new Set(['sendMessage', 'sendRichMessage']);

let instance: Bot | undefined;

function isGroupChat(chatId: unknown): boolean {
  if (typeof chatId === 'number') return chatId < 0;
  if (typeof chatId !== 'string' || !chatId.startsWith('-')) return false;
  const id = Number(chatId);
  return Number.isFinite(id) && id < 0;
}

/**
 * B-18. Сообщение бота в группу уходит без звука.
 * Явный `disable_notification: false` оставляем: так зовут вопрос о блокере и напоминание руководителю.
 */
export function silenceGroupPayload<T extends object>(method: string, payload: T): T {
  if (!GROUP_SENDS.has(method) || !('chat_id' in payload)) return payload;
  if ('disable_notification' in payload && payload.disable_notification === false) return payload;
  if (!isGroupChat(payload.chat_id)) return payload;
  return { ...payload, disable_notification: true };
}

/** Ставится на единственный клиент grammY. Правка сообщения звука не даёт и сюда не попадает. */
export const silenceGroupSends: Transformer = (prev, method, payload, signal) =>
  prev(method, silenceGroupPayload(method, payload), signal);

/** Единственный экземпляр grammY на процесс (B-12). Повторное создание — ошибка. */
export function createTelegramBot(token: string, botInfo?: TelegramBotInfo): Bot {
  if (token.length === 0) throw new Error('токен бота пуст');
  if (instance !== undefined) throw new Error('экземпляр grammY уже создан');
  instance = botInfo === undefined ? new Bot(token) : new Bot(token, { botInfo });
  instance.api.config.use(silenceGroupSends);
  return instance;
}

/** Тот же экземпляр, что создал процесс. Обработчики команд подключаются к нему. */
export function getTelegramBot(): Bot {
  if (instance === undefined) throw new Error('экземпляр grammY не создан');
  return instance;
}
