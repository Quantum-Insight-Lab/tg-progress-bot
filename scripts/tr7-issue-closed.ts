/**
 * TR-7 при закрытии issue (патч 1.3, 10.9): у закрытой issue отмечены все атомы.
 * Запускается workflow `.github/workflows/tr7-issue-closed.yml` на `issues: closed`:
 * неотмеченный атом — комментарий со списком, issue открывается снова, запуск красный.
 * Issues без раздела «Атомы ТЗ» (v1, чужие) не проверяются.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ATOMS_SECTION = '## Атомы ТЗ';
const ATOM = /^- \[( |x|X)\] (R-\d{3,}\b.*)$/;

/** Неотмеченные пункты раздела «Атомы ТЗ»; null — раздела нет, issue не из backlog v2. */
export function uncheckedAtoms(body: string): string[] | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === ATOMS_SECTION);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).flatMap((line) => {
    const match = ATOM.exec(line.trim());
    return match && match[1] === ' ' ? [match[2] ?? ''] : [];
  });
}

export function reopenComment(unchecked: string[]): string {
  return [
    `TR-7: issue закрыта, а атомов не отмечено: ${unchecked.length}. Открываю снова.`,
    '',
    ...unchecked.map((atom) => `- ${atom}`),
    '',
    'Неотмеченный атом — новая issue или `clarify`, а не «почти готово» (DoD). Перенесённый атом убирается из этой issue вместе с правкой её файла в `docs/backlog/`, после этого issue закрывается снова.',
  ].join('\n');
}

function main(): number {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
    issue: { number: number; body: string | null };
    repository: { full_name: string };
  };
  const { number, body } = event.issue;
  const repo = event.repository.full_name;
  const unchecked = uncheckedAtoms(body ?? '');
  if (unchecked === null) {
    console.log(`#${number}: раздела «Атомы ТЗ» нет — не issue backlog v2`);
    return 0;
  }
  if (unchecked.length === 0) {
    console.log(`#${number}: все атомы отмечены`);
    return 0;
  }
  execFileSync('gh', ['issue', 'comment', String(number), '--repo', repo, '--body', reopenComment(unchecked)], { stdio: 'inherit' });
  execFileSync('gh', ['issue', 'reopen', String(number), '--repo', repo], { stdio: 'inherit' });
  console.error(`#${number}: не отмечено ${unchecked.length}, issue открыта снова`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
