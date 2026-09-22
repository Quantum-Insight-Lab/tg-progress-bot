import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { ENV_KEYS } from "../../src/config/index.js";
import { repoRoot } from "../helpers/repo-root.js";

function listSrcTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSrcTs(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function rel(file: string): string {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

function filesMatching(pattern: RegExp): string[] {
  const srcRoot = join(repoRoot, "src");
  const hits: string[] = [];
  for (const file of listSrcTs(srcRoot)) {
    const text = readFileSync(file, "utf8");
    if (pattern.test(text)) {
      hits.push(rel(file));
    }
  }
  return hits.sort();
}

it("S-4: ровно одна реализация каждого механизма", () => {
  expect(filesMatching(/\bnew\s+Pool\s*\(/)).toEqual([
    "src/infrastructure/db.ts",
  ]);
  expect(filesMatching(/\bDate\.now\s*\(|\bnew\s+Date\s*\(/)).toEqual([
    "src/infrastructure/clock.ts",
  ]);
  expect(filesMatching(/export\s+const\s+logger\b/)).toEqual([
    "src/infrastructure/logger.ts",
  ]);
  expect(filesMatching(/\bprocess\.env\b/)).toEqual(["src/config/index.ts"]);
  expect(filesMatching(/\bclass\s+DomainError\b/)).toEqual([
    "src/domain/shared/errors.ts",
  ]);
  expect(filesMatching(/\bnew\s+Bot\s*\(/)).toEqual(["src/telegram/bot.ts"]);
  expect(filesMatching(/\bnew\s+Octokit\s*\(/)).toEqual([
    "src/github/client.ts",
  ]);
});

it("S-4: .env.example совпадает со схемой, секреты пустые, .env не в git", () => {
  const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const keys = example
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")));
  expect(keys.sort()).toEqual([...ENV_KEYS].sort());
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ]) {
    const line = example.split("\n").find((entry) => entry.startsWith(`${key}=`));
    expect(line).toBe(`${key}=`);
  }
  const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  expect(ignore.split("\n")).toContain(".env");
  expect(ignore.split("\n")).not.toContain(".env.example");
});
