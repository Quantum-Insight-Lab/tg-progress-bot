import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as constants from '../src/config/constants.ts';

const value = (cell: string): string | number => {
  const code = /`([^`]+)`/.exec(cell)?.[1];
  return code ?? Number(/^\s*(\d+)/.exec(cell)?.[1]);
};

describe('src/config совпадает с карточками констант', () => {
  it('каждая константа из docs/pda/05 есть в src/config с тем же значением, лишних нет', () => {
    const rows = [...readFileSync('docs/pda/05-constants.md', 'utf8').matchAll(/^\| C-\d+ \| `([A-Z_]+)` \| ([^|]+) \|/gm)];
    expect(rows.length).toBeGreaterThan(0);
    expect({ ...constants }).toEqual(Object.fromEntries(rows.map(([, name = '', cell = '']) => [name, value(cell)])));
  });
});
