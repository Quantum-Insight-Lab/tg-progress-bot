import { createSign } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { env } from "../config/index.js";
import { clock } from "../infrastructure/clock.js";
import { markGithubRateRemaining } from "../observability/index.js";

const TOKEN_SKEW_MS = 60_000;

type CachedToken = {
  token: string;
  expiresAtMs: number;
};

let client: Octokit | undefined;
let cachedToken: CachedToken | undefined;

function attachRateHook(instance: Octokit): void {
  instance.hook.after("request", (_options, response) => {
    const remaining = response.headers["x-ratelimit-remaining"];
    if (typeof remaining === "string") {
      const parsed = Number.parseInt(remaining, 10);
      if (Number.isFinite(parsed)) {
        markGithubRateRemaining(parsed);
      }
    }
  });
}

/** PEM из env: кавычки по краям и буквальные `\\n` из `--env-file`. */
export function githubAppPrivateKeyPem(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replaceAll("\\n", "\n");
}

function appJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(clock.now("UTC").epochMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(data).sign(privateKeyPem);
  return `${data}.${signature.toString("base64url")}`;
}

function githubApiHeaders(jwt: string): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    accept: "application/vnd.github+json",
    "user-agent": "progress-bot",
    "x-github-api-version": "2022-11-28",
  };
}

async function installationAccessToken(): Promise<string> {
  if (
    cachedToken !== undefined &&
    cachedToken.expiresAtMs - TOKEN_SKEW_MS > clock.now("UTC").epochMs
  ) {
    return cachedToken.token;
  }
  const { githubAppId, githubAppPrivateKey } = env();
  if (githubAppId === undefined || githubAppPrivateKey === undefined) {
    throw new Error("GITHUB_APP_ID и GITHUB_APP_PRIVATE_KEY не заданы");
  }
  const jwt = appJwt(githubAppId, githubAppPrivateKeyPem(githubAppPrivateKey));
  const installationsResponse = await fetch("https://api.github.com/app/installations", {
    headers: githubApiHeaders(jwt),
  });
  if (!installationsResponse.ok) {
    throw new Error(
      `GitHub App installations: ${String(installationsResponse.status)}`,
    );
  }
  const installations = (await installationsResponse.json()) as { id: number }[];
  const installation = installations[0];
  if (installation === undefined) {
    throw new Error("GitHub App не установлен");
  }
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${String(installation.id)}/access_tokens`,
    { method: "POST", headers: githubApiHeaders(jwt) },
  );
  if (!tokenResponse.ok) {
    throw new Error(`GitHub App token: ${String(tokenResponse.status)}`);
  }
  const body = (await tokenResponse.json()) as { token: string; expires_at: string };
  cachedToken = {
    token: body.token,
    expiresAtMs: Date.parse(body.expires_at),
  };
  return body.token;
}

/** Единственный Octokit (S-4, INV-09: только чтение от имени GitHub App). */
export function githubClient(): Octokit {
  if (client !== undefined) {
    return client;
  }
  const created = new Octokit();
  attachRateHook(created);
  created.hook.wrap("request", async (request, options) => {
    const token = await installationAccessToken();
    options.headers.authorization = `token ${token}`;
    return request(options);
  });
  client = created;
  return created;
}

/** Только для тестов. */
export function resetGithubClientForTests(): void {
  client = undefined;
  cachedToken = undefined;
}
