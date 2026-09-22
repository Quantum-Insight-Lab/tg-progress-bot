import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

it("образ не содержит секретов, миграции не в команде процесса", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const cmd = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("CMD "));
  expect(cmd).toEqual(['CMD ["node", "dist/src/index.js"]']);
  expect(dockerfile).not.toMatch(/^ENV\s+DATABASE_URL=/m);
  expect(dockerfile).not.toMatch(/^ENV\s+TELEGRAM_BOT_TOKEN=/m);
  expect(dockerfile).not.toMatch(/^ENV\s+GITHUB_/m);
  expect(dockerfile).not.toMatch(/COPY\s+\.env\b/);
  const ignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");
  expect(ignore.split("\n")).toContain(".env");
  expect(ignore.split("\n")).toContain("*.pem");
});
