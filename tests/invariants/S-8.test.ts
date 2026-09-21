import { join } from "node:path";
import { ESLint } from "eslint";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

async function lintDomain(code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, {
    filePath: join(repoRoot, "src/domain/s8-violation.ts"),
  });
  if (result === undefined) {
    throw new Error("eslint не вернул результат");
  }
  return result;
}

it("S-8: числовой порог в домене ломает lint", async () => {
  const result = await lintDomain(
    "export function stale(days: number): boolean {\n  return days > 2;\n}\n",
  );
  expect(result.errorCount).toBeGreaterThan(0);
  expect(result.messages.some((m) => m.ruleId === "no-magic-numbers")).toBe(
    true,
  );
});

it("S-8: 0, 1 и -1 в домене допускаются", async () => {
  const result = await lintDomain(
    `export function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}
`,
  );
  expect(
    result.messages.filter((m) => m.ruleId === "no-magic-numbers"),
  ).toEqual([]);
});
