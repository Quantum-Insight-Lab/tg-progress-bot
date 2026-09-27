/**
 * S-7: у каждого инварианта домена из docs/pda/04-invariants.md есть тест, имя которого начинается с его ID.
 *   npm run check:invariants              — отчёт: сколько INV без теста; падает только на тесте с несуществующим ID
 *   npm run check:invariants -- --strict  — любой INV без теста ломает сборку
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const INVARIANTS_PATH = 'docs/pda/04-invariants.md';
export const TESTS_DIR = 'tests';

const SPEC_ID = /^\| (INV-\d{2}) \|/gm;
const TEST_TITLE = /\b(?:it|test|describe)(?:\.(?:each\([^)]*\)|skip|only|todo))?\(\s*['"`](INV-\d{2})\b/g;

export function specIds(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(SPEC_ID)].map((m) => m[1] ?? ''))].sort();
}

export function testIds(sources: string[]): string[] {
  return [...new Set(sources.flatMap((source) => [...source.matchAll(TEST_TITLE)].map((m) => m[1] ?? '')))].sort();
}

export function compare(spec: string[], tests: string[]): { missing: string[]; unknown: string[] } {
  return { missing: spec.filter((id) => !tests.includes(id)), unknown: tests.filter((id) => !spec.includes(id)) };
}

function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function main(argv: string[]): number {
  const spec = specIds(readFileSync(INVARIANTS_PATH, 'utf8'));
  const tests = testIds(testFiles(TESTS_DIR).map((file) => readFileSync(file, 'utf8')));
  const { missing, unknown } = compare(spec, tests);
  const strict = argv.includes('--strict');
  console.log(`S-7 ${strict ? 'блок' : 'отчёт'}  инвариантов в спеке ${spec.length}, с тестом ${spec.length - missing.length}`);
  if (missing.length > 0) console.log(`      без теста: ${missing.join(', ')}`);
  if (unknown.length > 0) console.error(`      тесты ссылаются на INV, которых нет в ${INVARIANTS_PATH}: ${unknown.join(', ')}`);
  if (spec.length === 0) console.error(`      в ${INVARIANTS_PATH} нет строк вида | INV-xx |`);
  return unknown.length > 0 || spec.length === 0 || (strict && missing.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
