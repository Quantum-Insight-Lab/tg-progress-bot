import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_WEBHOOK_PATH } from '../src/github/webhook.ts';
import {
  liveSmokeProbe,
  runSmoke,
  SMOKE_SAMPLE_GAP_MS,
  smokeReport,
  smokeTargetFromEnv,
  type SmokeProbe,
  type SmokeTarget,
} from '../src/infrastructure/smoke.ts';
import { HEALTH_PATH, TELEGRAM_WEBHOOK_PATH } from '../src/telegram/webhook.ts';

const TOKEN = 'bot-token-value';
const PATHS = { telegram: TELEGRAM_WEBHOOK_PATH, github: GITHUB_WEBHOOK_PATH, health: HEALTH_PATH };
const TELEGRAM_URL = 'https://bot.example.com/telegram/webhook';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PUBLIC_HOST: 'bot.example.com',
    PUBLIC_WEBHOOK_ORIGIN: 'https://bot.example.com',
    TELEGRAM_BOT_TOKEN: TOKEN,
    ...overrides,
  };
}

function target(overrides: Partial<SmokeTarget> = {}): SmokeTarget {
  return { ...smokeTargetFromEnv(env(), PATHS), ...overrides };
}

function probe(partial: Partial<SmokeProbe> = {}): SmokeProbe & { slept: number[] } {
  const slept: number[] = [];
  const base: SmokeProbe & { slept: number[] } = {
    slept,
    tls: () => Promise.resolve({ status: 404, body: '' }),
    post: (url) => Promise.resolve({ status: 401, body: url }),
    get: (url) => Promise.resolve({ status: url.startsWith('https:') ? 404 : 200, body: '' }),
    webhookInfo: () => Promise.resolve({ url: TELEGRAM_URL, pendingUpdateCount: 1 }),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { ...base, ...partial, slept };
}

describe('проверка после сборки', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('пять шагов проходят и итог — одна строка', async () => {
    const fake = probe();
    const steps = await runSmoke(target(), fake);
    expect(steps.every((step) => step.ok)).toBe(true);
    expect(smokeReport(steps)).toBe('smoke: ok 5/5');
    expect(fake.slept).toEqual([SMOKE_SAMPLE_GAP_MS]);
  });

  it('адрес здоровья по умолчанию — локальный порт, HEALTH_URL его заменяет', () => {
    expect(smokeTargetFromEnv(env(), PATHS).healthUrl).toBe(`http://127.0.0.1:8088${HEALTH_PATH}`);
    expect(smokeTargetFromEnv(env({ APP_HOST_PORT: '9090' }), PATHS).healthUrl).toBe(`http://127.0.0.1:9090${HEALTH_PATH}`);
    expect(smokeTargetFromEnv(env({ HEALTH_URL: 'http://app:8080/healthz' }), PATHS).healthUrl).toBe('http://app:8080/healthz');
    expect(smokeTargetFromEnv(env(), PATHS).publicHealthUrl).toBe(`https://bot.example.com${HEALTH_PATH}`);
    expect(smokeTargetFromEnv(env(), PATHS).sampleGapMs).toBe(SMOKE_SAMPLE_GAP_MS);
  });

  it('разные имена хоста и пустой токен не собирают цель', () => {
    expect(() => smokeTargetFromEnv(env({ PUBLIC_HOST: 'other.example.com' }), PATHS)).toThrow('разные имена');
    expect(() => smokeTargetFromEnv(env({ TELEGRAM_BOT_TOKEN: '' }), PATHS)).toThrow('TELEGRAM_BOT_TOKEN не задан');
    expect(() => smokeTargetFromEnv(env({ HEALTH_URL: 'ftp://app/healthz' }), PATHS)).toThrow('HEALTH_URL');
  });

  it('чужой код TLS, webhook и рост очереди называются в итоге', async () => {
    const tls = await runSmoke(target(), probe({ tls: () => Promise.resolve({ status: 502, body: TOKEN }) }));
    expect(smokeReport(tls)).toBe('smoke: fail 4/5 — tls');
    const posts = await runSmoke(
      target(),
      probe({
        post: (url) => Promise.resolve({ status: url.endsWith('/github/webhook') ? 401 : 500, body: TOKEN }),
      }),
    );
    expect(smokeReport(posts)).toBe('smoke: fail 4/5 — POST /telegram/webhook');
    const stale = await runSmoke(
      target(),
      probe({
        webhookInfo: () => Promise.resolve({ url: TELEGRAM_URL, pendingUpdateCount: 4 }),
      }),
    );
    expect(smokeReport(stale)).toBe('smoke: ok 5/5');
    let pending = 1;
    const growing = await runSmoke(
      target(),
      probe({
        webhookInfo: () => {
          const current = pending;
          pending += 1;
          return Promise.resolve({ url: TELEGRAM_URL, pendingUpdateCount: current });
        },
      }),
    );
    expect(smokeReport(growing)).toBe('smoke: fail 4/5 — getWebhookInfo.pending_update_count');
    expect(smokeReport(stale)).not.toContain(TOKEN);
  });

  it('несовпадение адреса и отказ getWebhookInfo не печатают токен', async () => {
    const wrong = await runSmoke(
      target(),
      probe({
        webhookInfo: () => Promise.resolve({ url: 'https://other.example/hook', pendingUpdateCount: 0 }),
      }),
    );
    expect(smokeReport(wrong)).toBe('smoke: fail 4/5 — getWebhookInfo.url');
    const fake = probe({
      webhookInfo: () => Promise.reject(new Error(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`)),
    });
    const down = await runSmoke(target(), fake);
    expect(smokeReport(down)).toBe('smoke: fail 4/5 — getWebhookInfo');
    expect(smokeReport(down)).not.toContain(TOKEN);
    expect(fake.slept).toEqual([]);
  });

  it('адрес здоровья: пустое тело внутри и 404 снаружи', async () => {
    const body = await runSmoke(target(), probe({ get: (url) => Promise.resolve({ status: url.startsWith('https:') ? 404 : 200, body: 'данные' }) }));
    expect(smokeReport(body)).toBe('smoke: fail 4/5 — health.body');
    expect(smokeReport(body)).not.toContain('данные');
    const down = await runSmoke(target(), probe({ get: () => Promise.resolve({ status: 503, body: '' }) }));
    expect(smokeReport(down)).toBe('smoke: fail 4/5 — health, health.public');
    const leaked = await runSmoke(
      target(),
      probe({
        get: (url) => Promise.resolve({ status: url.startsWith('https:') ? 200 : 200, body: '' }),
      }),
    );
    expect(smokeReport(leaked)).toBe('smoke: fail 4/5 — health.public');
  });

  it('getWebhookInfo живого probe не кладёт токен в отказ', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`)));
    await expect(liveSmokeProbe().webhookInfo(TOKEN)).rejects.toThrow('getWebhookInfo: нет ответа');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('no', { status: 401 })));
    await expect(liveSmokeProbe().webhookInfo(TOKEN)).rejects.toThrow('getWebhookInfo: HTTP 401');
    vi.stubGlobal('fetch', (url: string) => {
      expect(String(url)).toContain(`/bot${TOKEN}/`);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { url: TELEGRAM_URL, pending_update_count: 2 } }), { status: 200 }),
      );
    });
    await expect(liveSmokeProbe().webhookInfo(TOKEN)).resolves.toEqual({
      url: TELEGRAM_URL,
      pendingUpdateCount: 2,
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 200 })));
    await expect(liveSmokeProbe().webhookInfo(TOKEN)).rejects.toThrow('getWebhookInfo: отказ');
  });
});
