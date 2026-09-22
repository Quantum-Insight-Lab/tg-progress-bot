import { z } from "zod";

/** C-1…C-7 из docs/pda/05-constants.md. Единственное место числовых порогов (S-8). */
export const constants = {
  staleDays: 2,
  reAskDays: 3,
  priorityWeights: {
    high: 3,
    normal: 2,
    low: 1,
  },
  defaultPriority: "normal",
  dayListMaxItems: 30,
  /** C-6 GITHUB_RECONCILE_INTERVAL, минуты. */
  githubReconcileIntervalMinutes: 30,
  /** docs/pda/08: coverage_gap выше половины — предупреждение у процента. */
  coverageGapWarnRatio: 0.5,
  reportSchedule: {
    daily: { hour: 9, minute: 0 },
    weekly: { isoWeekday: 5, hour: 18, minute: 0 },
  },
} as const;

export type Priority = keyof typeof constants.priorityWeights;

/** C-6 в миллисекундах. */
export function githubReconcileIntervalMs(): number {
  return constants.githubReconcileIntervalMinutes * 60 * 1000;
}

const envShape = {
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
};

const envSchema = z.object(envShape);

/** Имена переменных окружения. Пример — `.env.example`, чтение — только здесь. */
export const ENV_KEYS = Object.keys(envShape);

export type Env = {
  databaseUrl: string;
  telegramBotToken: string | undefined;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubWebhookSecret: string | undefined;
};

let cached: Env | undefined;

export function env(): Env {
  if (cached !== undefined) {
    return cached;
  }
  const parsed = envSchema.parse(process.env);
  cached = {
    databaseUrl: parsed.DATABASE_URL,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
  };
  return cached;
}

/** Только для тестов: сброс кэша после подмены process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
