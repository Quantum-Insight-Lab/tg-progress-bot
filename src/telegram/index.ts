export { bot, resetBotForTests } from "./bot.js";
export {
  bindGuardedCommand,
  resolveAccess,
  type IdentityDirectories,
} from "./bind.js";
export {
  TELEGRAM_HANDLER_IDS,
  wireTelegram,
  type TelegramDeps,
} from "./wire.js";
