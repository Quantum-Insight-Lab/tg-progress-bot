/**
 * S-4: один механизм на задачу из реестра AGENTS.md.
 *   npm run check:mechanisms
 * Строка «появится» файла ещё не требует. «есть» — ровно указанный файл, и известные клиенты не заведены вторым способом.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENTS_PATH = 'AGENTS.md';

const ROW = /^\| (.+?) \| (.+?) \| (.+?) \|$/;

export interface MechanismRow {
  task: string;
  mechanism: string;
  state: string;
}

export function mechanismRows(markdown: string): MechanismRow[] {
  const start = markdown.indexOf('## Реестр механизмов');
  const section = start < 0 ? '' : markdown.slice(start).split('## ')[1] ?? '';
  return section
    .split('\n')
    .map((line) => ROW.exec(line.trim()))
    .flatMap((match) => {
      if (match === null) return [];
      const task = match[1] ?? '';
      const mechanism = match[2] ?? '';
      const state = match[3] ?? '';
      if (task === 'Задача' || task.startsWith('---')) return [];
      return [{ task, mechanism, state }];
    });
}

export function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path.replaceAll('\\', '/')] : [];
  });
}

function pathsOf(mechanism: string): string[] {
  return [...mechanism.matchAll(/`(src\/[^`]+\.ts)`/g)].map((match) => match[1] ?? '');
}

/** Где в src встречается маркер. Путь с прямыми слэшами. */
export function filesContaining(sources: readonly string[], marker: string, read: (file: string) => string): string[] {
  return sources.filter((file) => read(file).includes(marker));
}

export function mechanismFindings(
  markdown: string,
  sources: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): string[] {
  const findings: string[] = [];
  for (const row of mechanismRows(markdown)) {
    if (row.state !== 'есть') continue;
    const paths = pathsOf(row.mechanism);
    for (const path of paths) {
      if (!existsSync(path)) findings.push(`${row.task}: нет файла ${path}`);
    }
  }
  if (sources.length === 0) return findings;
  const once: ReadonlyArray<readonly [string, string]> = [
    ['new Pool(', 'src/infrastructure/db.ts'],
    ['new Bot(', 'src/telegram/bot.ts'],
    ['new App(', 'src/github/client.ts'],
    ['new Kysely', 'src/infrastructure/db.ts'],
    ['new Date()', 'src/infrastructure/clock.ts'],
    ['Date.now()', 'src/infrastructure/clock.ts'],
  ];
  for (const [marker, only] of once) {
    const found = filesContaining(sources, marker, read);
    const extra = found.filter((file) => file !== only);
    const missing = found.length === 0 && marker !== 'Date.now()';
    if (missing) findings.push(`${marker}: нет ни в одном файле, ожидался ${only}`);
    if (extra.length > 0) findings.push(`${marker}: ещё в ${extra.join(', ')}, а должен быть только ${only}`);
  }
  return findings;
}

function main(): number {
  const findings = mechanismFindings(readFileSync(AGENTS_PATH, 'utf8'), sourceFiles('src'));
  if (findings.length === 0) {
    console.log('S-4 блок  механизмы из AGENTS.md сходятся с одним файлом');
    return 0;
  }
  for (const finding of findings) console.error(`S-4 ${finding}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
