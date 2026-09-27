import { describe, expect, it } from 'vitest';
import { compare, specIds, testIds } from '../scripts/check-invariants.ts';

// Заголовки собираются из частей, иначе сверка S-7 приняла бы этот файл за тесты инвариантов.
const call = (fn: string, quote: string, title: string): string => `${fn}(${quote}${title}${quote}, () => {})`;

describe('S-7: сверка инвариантов с тестами', () => {
  it('ID берутся из строк таблицы спеки и из начала имени теста', () => {
    expect(specIds('| INV-02 | b |\n| INV-01 | a |\nтекст INV-03')).toEqual(['INV-01', 'INV-02']);
    const sources = [call('it', "'", 'INV-01 доля'), call('describe', '"', 'INV-02: права'), call('test.skip', '`', 'INV-03 x'), call('it', "'", 'про INV-04')];
    expect(testIds(sources)).toEqual(['INV-01', 'INV-02', 'INV-03']);
  });

  it('инвариант без теста и тест с несуществующим ID', () => {
    expect(compare(['INV-01', 'INV-02'], ['INV-02', 'INV-09'])).toEqual({ missing: ['INV-01'], unknown: ['INV-09'] });
  });
});
