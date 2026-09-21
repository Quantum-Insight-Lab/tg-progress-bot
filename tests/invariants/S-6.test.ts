import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

function madgeCircular(cwd: string, target: string): {
  status: number;
  output: string;
} {
  const bin = join(repoRoot, "node_modules/madge/bin/cli.js");
  const result = spawnSync(
    process.execPath,
    [bin, "--circular", "--extensions", "ts", "--ts-config", join(repoRoot, "tsconfig.json"), target],
    { cwd, encoding: "utf8" },
  );
  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}

it("S-6: цикл модулей ломает madge --circular", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s6-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src/a.ts"),
      'import { b } from "./b.js";\nexport const a = b;\n',
    );
    await writeFile(
      join(dir, "src/b.ts"),
      'import { a } from "./a.js";\nexport const b = a;\n',
    );
    const result = madgeCircular(dir, "src");
    expect(result.status).not.toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("S-6: src без циклических зависимостей", () => {
  const result = madgeCircular(repoRoot, "src");
  expect(result.status).toBe(0);
  expect(result.output).toMatch(/No circular dependency found/i);
});
