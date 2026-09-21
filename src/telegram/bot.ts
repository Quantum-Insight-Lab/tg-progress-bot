import { Bot, type BotConfig, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { env } from "../config/index.js";
import { logger } from "../infrastructure/logger.js";

let instance: Bot | undefined;

const testBotInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "Progress",
  username: "progress_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function createBot(token: string, config?: BotConfig<Context>): Bot {
  const created = new Bot(token, config);
  created.catch((error) => {
    logger.error("telegram.unhandled", { message: error.message });
  });
  return created;
}

/** Единственный экземпляр grammY (S-4, AGENTS.md). */
export function bot(): Bot {
  if (instance !== undefined) {
    return instance;
  }
  const token = env().telegramBotToken;
  if (token === undefined) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан");
  }
  instance = createBot(token);
  return instance;
}

/** Только тесты: новый экземпляр без чтения env и без getMe. */
export function resetBotForTests(token = "1:test"): Bot {
  instance = createBot(token, { botInfo: testBotInfo });
  return instance;
}
