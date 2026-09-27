import { describe, expect, it } from 'vitest';
import { reopenComment, uncheckedAtoms } from '../scripts/tr7-issue-closed.ts';

const body = ['## PDA', '', 'A-1', '', '## Атомы ТЗ', '', '- [x] R-326 — `/task`', '- [X] R-226 — название', '- [ ] R-623 — бот заводит задачу', '', '## DoD', '', '- [ ] R-999 — вне раздела'].join('\n');

describe('TR-7 при закрытии issue', () => {
  it('неотмеченные — только пункты раздела «Атомы ТЗ»; [x] и [X] — отмечены', () => {
    expect(uncheckedAtoms(body)).toEqual(['R-623 — бот заводит задачу']);
    expect(uncheckedAtoms(body.replace('- [ ] R-623', '- [x] R-623'))).toEqual([]);
  });

  it('issue без раздела «Атомы ТЗ» не проверяется', () => {
    expect(uncheckedAtoms('## Сделать\n\n- [ ] что-то')).toBeNull();
  });

  it('комментарий перечисляет неотмеченные атомы', () => {
    expect(reopenComment(['R-623 — бот заводит задачу']).split('\n').slice(0, 3)).toEqual([
      'TR-7: issue закрыта, а атомов не отмечено: 1. Открываю снова.',
      '',
      '- R-623 — бот заводит задачу',
    ]);
  });
});
