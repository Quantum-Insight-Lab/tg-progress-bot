import { describe, expect, it } from 'vitest';
import { BRANCH, creationOrder, issueBody, milestonesFromIndex, withGithub, type BacklogIssue } from '../scripts/backlog-publish.ts';
import { parseIssue } from '../scripts/tz-check.ts';

const text = [
  '---',
  'id: I-07',
  'title: "tasks — пример"',
  'milestone: M3 Задачи и канвас',
  'labels: [context:tasks, type:feat]',
  'blocked_by: [I-02]',
  'state: open',
  '---',
  '',
  '# I-07. tasks — пример',
  '',
  '## Сделать',
  '',
  '- метрики из [08](../pda/08-observability.md) и [внешнее](https://example.com)',
  '',
].join('\n');
const issue = (): BacklogIssue => ({ ...parseIssue({ file: 'docs/backlog/I-07.md', text }).issue!, text });
const repo = 'https://github.com/org/repo';

describe('Публикация backlog', () => {
  it('milestones — строки таблицы «Этапы» с описанием', () => {
    const index = ['| Этап | Issues | Атомов | Что даёт |', '| --- | --- | --- | --- |', '| M1 Ядро | 2 | 14 | журнал и процесс |', '| [I-01](I-01.md) | M1 | x | 7 | — |'].join('\n');
    expect(milestonesFromIndex(index)).toEqual([{ title: 'v2 · M1 Ядро', description: 'журнал и процесс' }]);
  });

  it('тело issue: без front matter и заголовка, ссылки на документы — абсолютные на ветку', () => {
    const body = issueBody(issue(), repo);
    expect(body.startsWith(`Источник: [\`docs/backlog/I-07.md\`](${repo}/blob/${BRANCH}/docs/backlog/I-07.md)\n\n## Сделать`)).toBe(true);
    expect(body).toContain(`[08](${repo}/blob/${BRANCH}/docs/pda/08-observability.md)`);
    expect(body).toContain('[внешнее](https://example.com)');
    expect(body).not.toContain('blocked_by');
  });

  it('номер GitHub пишется в front matter и заменяется при повторе', () => {
    const once = withGithub(text, 91);
    expect(once).toContain('id: I-07\ngithub: 91\n');
    expect(parseIssue({ file: 'x.md', text: once }).issue?.github).toBe(91);
    expect(withGithub(once, 92).match(/^github: \d+$/gm)).toEqual(['github: 92']);
  });

  it('порядок создания: блокирующая issue раньше заблокированной', () => {
    const make = (id: string, blockedBy: string[]) => ({ id, blockedBy, file: '', title: id, labels: [], closed: false, atoms: [], elements: [] });
    expect(creationOrder([make('I-03', ['I-10']), make('I-10', ['I-02']), make('I-02', [])]).map((i) => i.id)).toEqual(['I-02', 'I-10', 'I-03']);
  });
});
