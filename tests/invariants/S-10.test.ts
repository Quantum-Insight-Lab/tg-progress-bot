import { join } from "node:path";
import { ESLint } from "eslint";
import { expect, it } from "vitest";
import { repoRoot } from "../helpers/repo-root.js";

async function lintDomain(code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, {
    filePath: join(repoRoot, "src/domain/s10-violation.ts"),
  });
  if (result === undefined) {
    throw new Error("eslint не вернул результат");
  }
  return result;
}

it("S-10: new Date() в домене ломает lint", async () => {
  const result = await lintDomain(
    "export function today(): Date {\n  return new Date();\n}\n",
  );
  expect(result.errorCount).toBeGreaterThan(0);
  expect(
    result.messages.some(
      (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("S-10"),
    ),
  ).toBe(true);
});

it("S-10: Date.now() в домене ломает lint", async () => {
  const result = await lintDomain(
    "export function now(): number {\n  return Date.now();\n}\n",
  );
  expect(result.errorCount).toBeGreaterThan(0);
  expect(
    result.messages.some(
      (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("S-10"),
    ),
  ).toBe(true);
});
