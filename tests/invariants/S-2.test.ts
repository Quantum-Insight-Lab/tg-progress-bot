import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cruiseWithConfig, loadDcConfig } from "../helpers/depcruise.js";

it("S-2: импорт projects → tasks ломает dependency-cruiser", async () => {
  const config = await loadDcConfig();
  const dir = await mkdtemp(join(tmpdir(), "s2-"));
  try {
    await mkdir(join(dir, "src/domain/projects"), { recursive: true });
    await mkdir(join(dir, "src/domain/tasks"), { recursive: true });
    await writeFile(
      join(dir, "src/domain/tasks/index.ts"),
      "export const tasks = true;\n",
    );
    await writeFile(
      join(dir, "src/domain/projects/index.ts"),
      'import "../tasks/index.js";\nexport {};\n',
    );
    const result = await cruiseWithConfig(dir, config);
    expect(
      result.summary.violations.some(
        (v) => v.rule.name === "S-2-projects-not-tasks",
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
