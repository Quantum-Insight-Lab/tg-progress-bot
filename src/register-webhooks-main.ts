import { GITHUB_WEBHOOK_PATH } from './github/webhook.ts';
import { webhookUrls, registerBotWebhook } from './infrastructure/webhook-host.ts';
import { createTelegramBot } from './telegram/bot.ts';
import { TELEGRAM_WEBHOOK_PATH } from './telegram/webhook.ts';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} не задан`);
  return value;
}

const telegramPath = process.env.TELEGRAM_WEBHOOK_PATH;
const path = telegramPath === undefined || telegramPath.length === 0 ? TELEGRAM_WEBHOOK_PATH : telegramPath;
const urls = webhookUrls(required(process.env, 'PUBLIC_WEBHOOK_ORIGIN'), path, GITHUB_WEBHOOK_PATH);
const bot = createTelegramBot(required(process.env, 'TELEGRAM_BOT_TOKEN'));
await registerBotWebhook(urls, required(process.env, 'TELEGRAM_WEBHOOK_SECRET'), required(process.env, 'GITHUB_WEBHOOK_SECRET'), (url, secretToken) =>
  bot.api.setWebhook(url, { secret_token: secretToken }).then(() => undefined),
);
console.log(urls.telegramUrl);
console.log(urls.githubUrl);
