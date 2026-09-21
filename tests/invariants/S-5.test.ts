import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { cruiseWithConfig, loadDcConfig } from "../helpers/depcruise.js";
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

it("S-5: импорт emit из проекции ломает dependency-cruiser", async () => {
  const config = await loadDcConfig();
  const dir = await mkdtemp(join(tmpdir(), "s5-"));
  try {
    await mkdir(join(dir, "src/projections"), { recursive: true });
    await mkdir(join(dir, "src/events"), { recursive: true });
    await writeFile(
      join(dir, "src/events/emit.ts"),
      "export function emit(): void {}\n",
    );
    await writeFile(
      join(dir, "src/projections/bad.ts"),
      'import { emit } from "../events/emit.js";\nexport const leaked = emit;\n',
    );
    const result = await cruiseWithConfig(dir, config);
    expect(
      result.summary.violations.some(
        (v) => v.rule.name === "S-5-projections-not-write-events",
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("S-5: типы из events/generated проекциям разрешены", async () => {
  const config = await loadDcConfig();
  const dir = await mkdtemp(join(tmpdir(), "s5-ok-"));
  try {
    await mkdir(join(dir, "src/projections"), { recursive: true });
    await mkdir(join(dir, "src/events/generated"), { recursive: true });
    await writeFile(
      join(dir, "src/events/generated/event-types.ts"),
      'export const EVENT_TYPES = { TASK_CHECKED: "task.checked" };\n',
    );
    await writeFile(
      join(dir, "src/projections/ok.ts"),
      'import { EVENT_TYPES } from "../events/generated/event-types.js";\nexport const type = EVENT_TYPES.TASK_CHECKED;\n',
    );
    const result = await cruiseWithConfig(dir, config);
    expect(
      result.summary.violations.filter(
        (v) => v.rule.name === "S-5-projections-not-write-events",
      ),
    ).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
