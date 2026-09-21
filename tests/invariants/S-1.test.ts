import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cruiseWithConfig, loadDcConfig } from "../helpers/depcruise.js";
import { repoRoot } from "../helpers/repo-root.js";

async function withTree(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "s1-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const full = join(dir, relative);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, contents);
    }
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("S-1: импорт domain → telegram ломает dependency-cruiser", async () => {
  const config = await loadDcConfig();
  await withTree(
    {
      "src/telegram/index.ts": "export const telegram = true;\n",
      "src/domain/bad.ts": 'import "../telegram/index.js";\nexport {};\n',
    },
    async (dir) => {
      const result = await cruiseWithConfig(dir, config);
      expect(
        result.summary.violations.some(
          (v) => v.rule.name === "S-1-domain-not-telegram",
        ),
      ).toBe(true);
    },
  );
});

it("S-1: текущий src/domain не тянет telegram, github, projections", async () => {
  const config = await loadDcConfig();
  const result = await cruiseWithConfig(repoRoot, config);
  const s1 = new Set([
    "S-1-domain-not-telegram",
    "S-1-domain-not-github",
    "S-1-domain-not-projections",
  ]);
  expect(
    result.summary.violations.filter((v) => s1.has(v.rule.name)),
  ).toEqual([]);
});
