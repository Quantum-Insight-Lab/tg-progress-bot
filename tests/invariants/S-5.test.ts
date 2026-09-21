import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

function listTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTs(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

it("S-5: проекции не пишут в журнал events", () => {
  const root = join(repoRoot, "src/projections");
  const hits: string[] = [];
  for (const file of listTs(root)) {
    const text = readFileSync(file, "utf8");
    const path = relative(repoRoot, file).replaceAll("\\", "/");
    if (
      text.includes("from \"../events/emit") ||
      text.includes("insertInto(\"events\")") ||
      /\bemit\s*\(/.test(text)
    ) {
      hits.push(path);
    }
  }
  expect(hits).toEqual([]);
});
