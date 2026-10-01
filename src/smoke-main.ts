import { GITHUB_WEBHOOK_PATH } from './github/webhook.ts';
import { liveSmokeProbe, runSmoke, smokeReport, smokeTargetFromEnv } from './infrastructure/smoke.ts';
import { HEALTH_PATH, TELEGRAM_WEBHOOK_PATH } from './telegram/webhook.ts';

const telegramPathRaw = process.env.TELEGRAM_WEBHOOK_PATH?.trim() ?? '';
const telegramPath = telegramPathRaw.length === 0 ? TELEGRAM_WEBHOOK_PATH : telegramPathRaw;
const target = smokeTargetFromEnv(
  {
    PUBLIC_WEBHOOK_ORIGIN: process.env.PUBLIC_WEBHOOK_ORIGIN,
    PUBLIC_HOST: process.env.PUBLIC_HOST,
    HEALTH_URL: process.env.HEALTH_URL,
    APP_HOST_PORT: process.env.APP_HOST_PORT,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  },
  { telegram: telegramPath, github: GITHUB_WEBHOOK_PATH, health: HEALTH_PATH },
);
const steps = await runSmoke(target, liveSmokeProbe());
console.log(smokeReport(steps));
if (steps.some((step) => !step.ok)) process.exitCode = 1;
