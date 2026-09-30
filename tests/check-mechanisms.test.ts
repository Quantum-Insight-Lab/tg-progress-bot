import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesContaining, mechanismFindings, mechanismRows, sourceFiles } from '../scripts/check-mechanisms.ts';

describe('S-4 перепись механизмов', () => {
  it('S-4 реестр AGENTS.md: «есть» указывает на файл, клиенты не заведены дважды', () => {
    const findings = mechanismFindings(readFileSync('AGENTS.md', 'utf8'), sourceFiles('src'));
    expect(findings).toEqual([]);
  });

  it('S-4 строка «появится» не требует файла', () => {
    const rows = mechanismRows(
      '## Реестр механизмов\n\n| Задача | Механизм | Состояние |\n| --- | --- | --- |\n| Логирование | `src/infrastructure/logger.ts` | появится |\n',
    );
    expect(rows).toEqual([{ task: 'Логирование', mechanism: '`src/infrastructure/logger.ts`', state: 'появится' }]);
    expect(
      mechanismFindings('## Реестр механизмов\n\n| Задача | Механизм | Состояние |\n| Логирование | `src/infrastructure/logger.ts` | появится |\n', []),
    ).toEqual([]);
  });

  it('S-4 второй new Pool ломает проверку', () => {
    const sources = ['src/infrastructure/db.ts', 'src/other.ts'];
    const read = (file: string) => (file.endsWith('db.ts') || file.endsWith('other.ts') ? 'new Pool(' : '');
    expect(filesContaining(sources, 'new Pool(', read)).toEqual(sources);
  });
});
