import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { EVENT_TYPES, EVENT_TYPE_VALUES } from "../../src/events/generated/index.js";
import { repoRoot } from "../helpers/repo-root.js";

async function lint(filePath: string, code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) {
    throw new Error("eslint не вернул результат");
  }
  return result;
}

it('S-3: emit("task.checked") ломает lint', async () => {
  const result = await lint(
    join(repoRoot, "src/events/s3-violation.ts"),
    'export function publish(emit: (t: string) => void): void {\n  emit("task.checked");\n}\n',
  );
  expect(result.errorCount).toBeGreaterThan(0);
  expect(
    result.messages.some(
      (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("S-3"),
    ),
  ).toBe(true);
});

it("S-3: emit(EVENT_TYPES.*) проходит lint", async () => {
  const result = await lint(
    join(repoRoot, "src/events/s3-ok.ts"),
    `import { EVENT_TYPES } from "./generated/index.js";
export function publish(emit: (t: string) => void): void {
  emit(EVENT_TYPES.TASK_CHECKED);
}
`,
  );
  expect(
    result.messages.filter((m) => m.ruleId === "no-restricted-syntax"),
  ).toEqual([]);
});

it("S-3: сгенерированные константы покрывают реестр", () => {
  const registry = parse(
    readFileSync(join(repoRoot, "contracts/event-registry.yaml"), "utf8"),
  ) as { events: Array<{ type: string }> };
  const fromYaml = registry.events.map((e) => e.type).sort();
  const fromCode = [...EVENT_TYPE_VALUES].sort();
  expect(fromCode).toEqual(fromYaml);
  expect(EVENT_TYPES.TASK_CHECKED).toBe("task.checked");
});
