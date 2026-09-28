import { Bot, type BotConfig, type Context } from 'grammy';

/** Сведения о боте из `getMe`. Если переданы при создании, повторный `getMe` не нужен. */
export type TelegramBotInfo = NonNullable<BotConfig<Context>['botInfo']>;

let instance: Bot | undefined;

/** Единственный экземпляр grammY на процесс (B-12). Повторное создание — ошибка. */
export function createTelegramBot(token: string, botInfo?: TelegramBotInfo): Bot {
  if (token.length === 0) throw new Error('токен бота пуст');
  if (instance !== undefined) throw new Error('экземпляр grammY уже создан');
  instance = botInfo === undefined ? new Bot(token) : new Bot(token, { botInfo });
  return instance;
}

/** Тот же экземпляр, что создал процесс. Обработчики команд подключаются к нему. */
export function getTelegramBot(): Bot {
  if (instance === undefined) throw new Error('экземпляр grammY не создан');
  return instance;
}
