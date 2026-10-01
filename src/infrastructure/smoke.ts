import { webhookUrls } from './webhook-host.ts';

/** Пауза между двумя `getWebhookInfo`, чтобы увидеть рост очереди. */
export const SMOKE_SAMPLE_GAP_MS = 2000;

const REQUEST_TIMEOUT_MS = 10_000;
const STATUS_NOT_FOUND = 404;
const STATUS_UNAUTHORIZED = 401;
const STATUS_OK = 200;
const DEFAULT_APP_HOST_PORT = '8088';

export interface SmokeTarget {
  tlsUrl: string;
  telegramUrl: string;
  githubUrl: string;
  healthUrl: string;
  publicHealthUrl: string;
  botToken: string;
  sampleGapMs: number;
}

export interface SmokeProbe {
  tls(url: string): Promise<ProbeResponse>;
  post(url: string, body: string): Promise<ProbeResponse>;
  get(url: string): Promise<ProbeResponse>;
  webhookInfo(token: string): Promise<WebhookInfo>;
  sleep(ms: number): Promise<void>;
}

export interface SmokeStep {
  ok: boolean;
  /** Пусто, когда шаг прошёл. Иначе имя проверки, без значений и секретов. */
  reason: string;
}

interface ProbeResponse {
  status: number;
  body: string;
}

interface WebhookInfo {
  url: string;
  pendingUpdateCount: number;
  lastErrorMessage: string;
}

interface SmokePaths {
  telegram: string;
  github: string;
  health: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim() ?? '';
  if (value.length === 0) throw new Error(`${name} не задан`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} — адрес http`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} — адрес http`);
  return url.toString();
}

/** Цель проверки из окружения. Токен в текст ошибки не попадает. */
export function smokeTargetFromEnv(env: NodeJS.ProcessEnv, paths: SmokePaths): SmokeTarget {
  const origin = required(env, 'PUBLIC_WEBHOOK_ORIGIN');
  const host = required(env, 'PUBLIC_HOST');
  const urls = webhookUrls(origin, paths.telegram, paths.github);
  const originUrl = new URL(origin);
  if (originUrl.hostname !== host) throw new Error('PUBLIC_HOST и PUBLIC_WEBHOOK_ORIGIN — разные имена');
  const healthSet = env.HEALTH_URL?.trim() ?? '';
  const port = env.APP_HOST_PORT?.trim() ?? '';
  const healthUrl =
    healthSet.length === 0 ? `http://127.0.0.1:${port.length === 0 ? DEFAULT_APP_HOST_PORT : port}${paths.health}` : httpUrl(healthSet, 'HEALTH_URL');
  const tls = new URL(origin);
  tls.pathname = '/';
  tls.search = '';
  tls.hash = '';
  return {
    tlsUrl: tls.toString(),
    telegramUrl: urls.telegramUrl,
    githubUrl: urls.githubUrl,
    healthUrl,
    publicHealthUrl: new URL(paths.health, originUrl.origin).toString(),
    botToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    sampleGapMs: SMOKE_SAMPLE_GAP_MS,
  };
}

async function exchange(url: string, init: RequestInit = {}): Promise<ProbeResponse> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  return { status: response.status, body: await response.text() };
}

/** `getWebhookInfo` без токена в тексте отказа. */
async function readWebhookInfo(token: string): Promise<WebhookInfo> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('getWebhookInfo: нет ответа');
  }
  if (!response.ok) throw new Error(`getWebhookInfo: HTTP ${response.status}`);
  let json: unknown;
  try {
    json = (await response.json()) as unknown;
  } catch {
    throw new Error('getWebhookInfo: не json');
  }
  if (!isRecord(json) || json.ok !== true || !isRecord(json.result)) throw new Error('getWebhookInfo: отказ');
  const result = json.result;
  const url = result.url;
  const pending = result.pending_update_count;
  const last = result.last_error_message;
  if (typeof url !== 'string' || typeof pending !== 'number') throw new Error('getWebhookInfo: отказ');
  if (last !== undefined && typeof last !== 'string') throw new Error('getWebhookInfo: отказ');
  return { url, pendingUpdateCount: pending, lastErrorMessage: last ?? '' };
}

/** Живые запросы: TLS с проверкой имени, коды webhook, `getWebhookInfo`, адрес здоровья. */
export function liveSmokeProbe(): SmokeProbe {
  return {
    tls: (url) => exchange(url),
    post: (url, body) => exchange(url, { method: 'POST', body }),
    get: (url) => exchange(url),
    webhookInfo: (token) => readWebhookInfo(token),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function take(fallback: string, run: () => Promise<string | null>): Promise<SmokeStep> {
  try {
    const reason = await run();
    if (reason === null) return { ok: true, reason: '' };
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: fallback };
  }
}

async function webhookInfoStep(target: SmokeTarget, probe: SmokeProbe): Promise<string | null> {
  let first: WebhookInfo;
  try {
    first = await probe.webhookInfo(target.botToken);
  } catch {
    return 'getWebhookInfo';
  }
  await probe.sleep(target.sampleGapMs);
  let second: WebhookInfo;
  try {
    second = await probe.webhookInfo(target.botToken);
  } catch {
    return 'getWebhookInfo';
  }
  const reasons: string[] = [];
  if (first.url !== target.telegramUrl || second.url !== target.telegramUrl) reasons.push('getWebhookInfo.url');
  if (first.lastErrorMessage !== '' || second.lastErrorMessage !== '') reasons.push('getWebhookInfo.last_error_message');
  if (second.pendingUpdateCount > first.pendingUpdateCount) reasons.push('getWebhookInfo.pending_update_count');
  return reasons.length === 0 ? null : reasons.join(', ');
}

async function healthStep(target: SmokeTarget, probe: SmokeProbe): Promise<string | null> {
  const reasons: string[] = [];
  try {
    const local = await probe.get(target.healthUrl);
    if (local.status !== STATUS_OK) reasons.push('health');
    else if (local.body !== '') reasons.push('health.body');
  } catch {
    reasons.push('health');
  }
  try {
    const outside = await probe.get(target.publicHealthUrl);
    if (outside.status !== STATUS_NOT_FOUND) reasons.push('health.public');
  } catch {
    reasons.push('health.public');
  }
  return reasons.length === 0 ? null : reasons.join(', ');
}

/** Пять шагов. Отказ одного не отменяет остальные. Секреты и тексты ответов в причины не входят. */
export async function runSmoke(target: SmokeTarget, probe: SmokeProbe): Promise<SmokeStep[]> {
  return [
    await take('tls', async () => {
      const response = await probe.tls(target.tlsUrl);
      return response.status === STATUS_NOT_FOUND ? null : 'tls';
    }),
    await take('POST /telegram/webhook', async () => {
      const response = await probe.post(target.telegramUrl, '{}');
      return response.status === STATUS_UNAUTHORIZED ? null : 'POST /telegram/webhook';
    }),
    await take('POST /github/webhook', async () => {
      const response = await probe.post(target.githubUrl, '{}');
      return response.status === STATUS_UNAUTHORIZED ? null : 'POST /github/webhook';
    }),
    await take('getWebhookInfo', () => webhookInfoStep(target, probe)),
    await take('health', () => healthStep(target, probe)),
  ];
}

/** Одна строка: `smoke: ok 5/5` или `smoke: fail 4/5 — …`. */
export function smokeReport(steps: readonly SmokeStep[]): string {
  const passed = steps.filter((step) => step.ok).length;
  if (passed === steps.length) return `smoke: ok ${passed}/${steps.length}`;
  const reasons = steps.filter((step) => !step.ok).map((step) => step.reason);
  return `smoke: fail ${passed}/${steps.length} — ${reasons.join(', ')}`;
}
