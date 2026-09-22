import type { Bot } from "grammy";
import { logger } from "../infrastructure/logger.js";
import {
  leadTelegramUserIds,
  takeDueImmediateAlerts,
} from "../observability/index.js";

export async function notifyStabilityAlerts(bot: Bot): Promise<void> {
  const alerts = takeDueImmediateAlerts();
  if (alerts.length === 0) {
    return;
  }
  const leads = await leadTelegramUserIds();
  for (const alert of alerts) {
    logger.error("stability.alert", { kind: alert.kind, text: alert.text });
    for (const telegramUserId of leads) {
      const chatId = Number.parseInt(telegramUserId, 10);
      if (!Number.isFinite(chatId)) {
        continue;
      }
      await bot.api.sendMessage(chatId, alert.text);
    }
  }
}
