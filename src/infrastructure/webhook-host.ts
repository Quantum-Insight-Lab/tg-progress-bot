/** Адреса приёма на одном TLS-хосте. Запись webhook в GitHub сюда не входит. */
export interface WebhookUrls {
  telegramUrl: string;
  githubUrl: string;
}

const TELEGRAM_WEBHOOK_PORTS = new Set(['', '443', '8443']);

function httpsOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('PUBLIC_WEBHOOK_ORIGIN — адрес https');
  }
  if (url.protocol !== 'https:') throw new Error('PUBLIC_WEBHOOK_ORIGIN — только TLS');
  if (url.username.length > 0 || url.password.length > 0) throw new Error('PUBLIC_WEBHOOK_ORIGIN — без секретов');
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) throw new Error('PUBLIC_WEBHOOK_ORIGIN — хост без пути');
  if (!TELEGRAM_WEBHOOK_PORTS.has(url.port)) throw new Error('PUBLIC_WEBHOOK_ORIGIN — порт 443 или 8443');
  return url;
}

function webhookPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) throw new Error('путь webhook');
  return path;
}

/** Telegram и GitHub App принимают доставку на одном хосте. Пути разные. */
export function webhookUrls(origin: string, telegramPath: string, githubPath: string): WebhookUrls {
  const base = httpsOrigin(origin);
  const telegram = webhookPath(telegramPath);
  const github = webhookPath(githubPath);
  if (telegram === github) throw new Error('пути webhook совпали');
  const telegramUrl = new URL(telegram, base.origin);
  const githubUrl = new URL(github, base.origin);
  if (telegramUrl.host !== githubUrl.host || telegramUrl.host !== base.host) throw new Error('webhooks на разных хостах');
  return { telegramUrl: telegramUrl.toString(), githubUrl: githubUrl.toString() };
}

/** `setWebhook` бота на адрес Telegram. URL GitHub App только возвращается: бот в GitHub не пишет. */
export async function registerBotWebhook(
  urls: WebhookUrls,
  telegramSecret: string,
  githubSecret: string,
  setWebhook: (url: string, secretToken: string) => Promise<void>,
): Promise<void> {
  if (telegramSecret.length === 0) throw new Error('TELEGRAM_WEBHOOK_SECRET не задан');
  if (githubSecret.length === 0) throw new Error('GITHUB_WEBHOOK_SECRET не задан');
  const telegram = new URL(urls.telegramUrl);
  const github = new URL(urls.githubUrl);
  if (telegram.protocol !== 'https:' || github.protocol !== 'https:' || telegram.host !== github.host) {
    throw new Error('webhooks на разных хостах');
  }
  await setWebhook(urls.telegramUrl, telegramSecret);
}
