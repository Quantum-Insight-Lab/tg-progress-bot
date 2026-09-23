import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { resetEnvCache } from "../../src/config/index.js";
import {
  githubAppPrivateKeyPem,
  githubClient,
  resetGithubClientForTests,
} from "../../src/github/client.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGithubClientForTests();
  resetEnvCache();
});

it("INV-09: клиент читает через installation token App", async () => {
  const quoted = `"${privateKey.replaceAll("\n", "\\n")}"`;
  expect(githubAppPrivateKeyPem(quoted)).toBe(privateKey);
  process.env["GITHUB_APP_ID"] = "5028853";
  process.env["GITHUB_APP_PRIVATE_KEY"] = quoted;
  resetEnvCache();
  resetGithubClientForTests();

  let seenAuthorization: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/app/installations")) {
        return Response.json([{ id: 7 }]);
      }
      if (url.endsWith("/access_tokens")) {
        return Response.json({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      seenAuthorization = new Headers(init?.headers).get("authorization");
      return Response.json(
        { login: "bot" },
        { headers: { "x-ratelimit-remaining": "4999" } },
      );
    }),
  );

  const user = await githubClient().request("GET /user");
  expect(user.status).toBe(200);
  expect(seenAuthorization).toBe("token ghs_test");
});
