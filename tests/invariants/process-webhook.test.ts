import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWebhookServer, GITHUB_WEBHOOK_PATH } from "../../src/process/server.js";
import { resetBotForTests } from "../../src/telegram/bot.js";
import { repoRoot } from "../helpers/repo-root.js";

it("INV-08: HTTP webhook GitHub с неверной подписью отвечает 401", async () => {
  const server = createWebhookServer({
    bot: resetBotForTests(),
    githubSecret: "secret",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${GITHUB_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=00",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

it("процесс слушает оба webhook и поднимает те же циклы", () => {
  const index = readFileSync(join(repoRoot, "src/index.ts"), "utf8");
  expect(index).toContain("startGithubReconcileLoop");
  expect(index).toContain("startDailyReportLoop");
  expect(index).not.toContain("setInterval");
  expect(index).not.toContain("applyMigrations");
  const server = readFileSync(join(repoRoot, "src/process/server.ts"), "utf8");
  expect(server).toContain("/telegram/webhook");
  expect(server).toContain("/github/webhook");
});
