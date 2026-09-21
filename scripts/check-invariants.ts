/**
 * S-7: каждый INV-xx из docs/pda/04-invariants.md имеет тест с этим префиксом в имени.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const specIdRe = /^\| INV-(\d{2}) \|/gm;
const testTitleRe =
  /(?:^|[\s;])(?:it|test)(?:\.(?:todo|skip|only))?\(\s*(['"`])INV-(\d{2})\b/g;

export function specInvariantIds(markdown: string): string[] {
  const ids = new Set<string>();
  specIdRe.lastIndex = 0;
  for (const match of markdown.matchAll(specIdRe)) {
    const n = match[1];
    if (n !== undefined) ids.add(`INV-${n}`);
  }
  return [...ids].sort();
}

export function testInvariantIds(sources: string[]): string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    testTitleRe.lastIndex = 0;
    for (const match of source.matchAll(testTitleRe)) {
      const n = match[2];
      if (n !== undefined) ids.add(`INV-${n}`);
    }
  }
  return [...ids].sort();
}

export function diffInvariantIds(
  specIds: string[],
  testIds: string[],
): { missing: string[]; extra: string[] } {
  const spec = new Set(specIds);
  const tests = new Set(testIds);
  return {
    missing: specIds.filter((id) => !tests.has(id)),
    extra: testIds.filter((id) => !spec.has(id)),
  };
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

export function checkRepo(repoRoot: string = root): {
  specIds: string[];
  testIds: string[];
  missing: string[];
  extra: string[];
} {
  const specIds = specInvariantIds(
    readFileSync(join(repoRoot, "docs/pda/04-invariants.md"), "utf8"),
  );
  const sources = listTsFiles(join(repoRoot, "tests")).map((file) =>
    readFileSync(file, "utf8"),
  );
  const testIds = testInvariantIds(sources);
  const { missing, extra } = diffInvariantIds(specIds, testIds);
  return { specIds, testIds, missing, extra };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { specIds, missing, extra } = checkRepo();
  if (specIds.length === 0) {
    process.stderr.write(
      "S-7: в docs/pda/04-invariants.md нет ID вида | INV-xx |.\n",
    );
    process.exitCode = 1;
  } else if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) {
      process.stderr.write(
        `S-7: в спеке нет теста с префиксом: ${missing.join(", ")}\n`,
      );
    }
    if (extra.length > 0) {
      process.stderr.write(
        `S-7: в тестах ID, которых нет в спеке: ${extra.join(", ")}\n`,
      );
    }
    process.exitCode = 1;
  }
}
