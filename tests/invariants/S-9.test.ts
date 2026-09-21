import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

it("S-9: knip в CI идёт предупреждением, не ломает сборку", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  expect(workflow).toMatch(
    /- run: npm run knip\n[ \t]+continue-on-error:\s*true/,
  );
  expect(workflow).toMatch(/- run: npm run circular\n/);
  expect(workflow).not.toMatch(
    /- run: npm run circular\n[ \t]+continue-on-error:/,
  );
});
