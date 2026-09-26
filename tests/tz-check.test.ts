import { describe, expect, it } from 'vitest';
import {
  atomTexts,
  check,
  coverage,
  formatTrace,
  MAX_ATOMS_PER_STEP,
  parseEventRegistry,
  parseIssue,
  parsePdaElements,
  splitBlocks,
  type Finding,
  type Rule,
} from '../scripts/tz-check.ts';

const registry = (atoms: string, glossary = ''): string => `source: tz.md\n${glossary}atoms:\n${atoms}`;

function run(markdown: string, registryText: string, gate = false): Finding[] {
  return check(registryText, () => markdown, { gate }).findings;
}

function messages(findings: Finding[], rule: Rule): string[] {
  return findings.filter((f) => f.rule === rule).map((f) => f.message);
}

const SCOPE = '  R-001: { kind: scope, release: mvp }\n';

describe('splitBlocks', () => {
  it('режет абзацы, пункты списков, строки цитат и таблиц; заголовки и разделители не блоки', () => {
    const blocks = splitBlocks(
      [
        '# Заголовок',
        'Первый абзац',
        'продолжается здесь.',
        '',
        '---',
        '',
        '1. {R-001} пункт',
        '   - {R-002} вложенный пункт',
        '',
        '> {R-003} строка цитаты',
        '>',
        '> - {R-004} пункт в цитате',
        '',
        '| {ctx} Колонка | Значение |',
        '| --- | --- |',
        '| {R-005} поле | x |',
        '',
        '```',
        '{ctx} схема',
        'вторая строка схемы',
        '```',
      ].join('\n'),
    );
    expect(blocks.map((b) => [b.line, b.text])).toEqual([
      [2, 'Первый абзац продолжается здесь.'],
      [7, '{R-001} пункт'],
      [8, '{R-002} вложенный пункт'],
      [10, '{R-003} строка цитаты'],
      [12, '{R-004} пункт в цитате'],
      [14, '{ctx} Колонка | Значение |'],
      [16, '{R-005} поле | x |'],
      [19, '{ctx} схема'],
    ]);
    expect(blocks.every((b) => b.section.title === 'Заголовок')).toBe(true);
  });
});

describe('TR-1: каждый блок начинается с якоря', () => {
  const markdown = ['## Размечен', '{R-001} есть якорь', '', 'нет якоря', '', '## Не начат', 'просто текст'].join('\n');

  it('на шаге 0 размеченный раздел проверяется целиком, неначатый пропускается', () => {
    const tr1 = messages(run(markdown, registry(SCOPE)), 'TR-1');
    expect(tr1).toHaveLength(1);
    expect(tr1[0]).toContain('стр. 4');
  });

  it('на gate проверяются все разделы', () => {
    expect(messages(run(markdown, registry(SCOPE), true), 'TR-1')).toHaveLength(2);
  });

  it('якорь в середине блока не заменяет якорь в начале', () => {
    const tr1 = messages(run('{R-001} начало\n\nтекст {ctx} потом', registry(SCOPE)), 'TR-1');
    expect(tr1).toHaveLength(1);
  });

  it('{ctx} считается якорем', () => {
    expect(messages(run('{R-001} атом\n\n{ctx} обоснование', registry(SCOPE)), 'TR-1')).toEqual([]);
  });
});

describe('TR-2: номера и совпадение ТЗ с реестром', () => {
  it('один номер на двух блоках', () => {
    const tr2 = messages(run('{R-001} раз\n\n{R-001} два', registry(SCOPE)), 'TR-2');
    expect(tr2.join('\n')).toContain('нескольких местах');
  });

  it('якорь без записи в реестре и запись без якоря', () => {
    const tr2 = messages(run('{R-001} раз\n\n{R-003} три', registry(`${SCOPE}  R-002: { kind: scope, release: mvp }\n`)), 'TR-2');
    expect(tr2.join('\n')).toContain('R-003 (стр. 3) нет в реестре');
    expect(tr2.join('\n')).toContain('R-002 есть в реестре, но нет в ТЗ');
  });

  it('отозванный атом остаётся в реестре без якоря; с якорем — ошибка', () => {
    const withdrawn = `${SCOPE}  R-002: { kind: scope, release: mvp, decision: withdrawn, note: смысл сменился }\n`;
    expect(messages(run('{R-001} раз', registry(withdrawn)), 'TR-2')).toEqual([]);
    expect(messages(run('{R-001} раз\n\n{R-002} два', registry(withdrawn)), 'TR-2').join('\n')).toContain('отозван');
  });

  it('пропуск в нумерации виден', () => {
    const tr2 = messages(run('{R-001} раз\n\n{R-003} три', registry(`${SCOPE}  R-003: { kind: scope, release: mvp }\n`)), 'TR-2');
    expect(tr2.join('\n')).toContain('R-002 пропущен');
  });

  it('номер в неканонической записи', () => {
    const findings = run('{R-001} раз\n\n{R-0002} два', registry(SCOPE));
    expect(messages(findings, 'TR-2').join('\n')).toContain('R-0002 — номер пишется');
  });

  it('ссылка на несуществующий или отозванный атом', () => {
    const atoms = `${SCOPE}  R-002: { kind: rule, scope: R-009 }\n  R-003: { kind: scope, release: mvp, decision: withdrawn, note: снят }\n  R-004: { kind: rule, scope: R-003 }\n`;
    const tr2 = messages(run('{R-001} a\n\n{R-002} b\n\n{R-004} d', registry(atoms)), 'TR-2').join('\n');
    expect(tr2).toContain('R-002.scope → R-009: такого атома нет');
    expect(tr2).toContain('R-004.scope → R-003: атом отозван');
  });
});

describe('TR-3: релиз доказан ссылкой на scope', () => {
  it('атом без scope — ошибка, если это не clarify', () => {
    const atoms = `${SCOPE}  R-002: { kind: rule }\n  R-003: { kind: rule, decision: clarify, note: нет пункта в объёме работ }\n`;
    const tr3 = messages(run('{R-001} a\n\n{R-002} b\n\n{R-003} c', registry(atoms)), 'TR-3');
    expect(tr3).toHaveLength(1);
    expect(tr3[0]).toContain('R-002: нет scope');
  });

  it('scope указывает на атом другого вида', () => {
    const atoms = `${SCOPE}  R-002: { kind: rule, scope: R-001 }\n  R-003: { kind: view, scope: R-002 }\n`;
    const tr3 = messages(run('{R-001} a\n\n{R-002} b\n\n{R-003} c', registry(atoms)), 'TR-3');
    expect(tr3).toEqual(['R-003.scope → R-002: это атом вида rule, а не scope']);
  });

  it('у атома вида scope обязателен release', () => {
    const tr3 = messages(run('{R-001} a', registry('  R-001: { kind: scope }\n')), 'TR-3');
    expect(tr3[0]).toContain('нет release');
  });

  it('deferred не может ссылаться на пункт MVP', () => {
    const atoms = `${SCOPE}  R-002: { kind: rule, scope: R-001, decision: deferred }\n`;
    expect(messages(run('{R-001} a\n\n{R-002} b', registry(atoms)), 'TR-3')).toEqual(['R-002: deferred, но scope R-001 — MVP']);
  });

  it('повтор (same_as) того же вида и релиза', () => {
    const atoms = `${SCOPE}  R-002: { kind: scope, release: later, decision: same_as, same_as: R-001 }\n`;
    expect(messages(run('{R-001} a\n\n{R-002} b', registry(atoms)), 'TR-3').join('\n')).toContain('релиз другой');
  });
});

describe('REG: схема реестра', () => {
  it('неизвестные вид, поле, решение без причины, same_as без цели', () => {
    const atoms = [
      '  R-001: { kind: screen }',
      '  R-002: { kind: scope, release: mvp, color: red }',
      '  R-003: { kind: rule, scope: R-002, decision: rejected }',
      '  R-004: { kind: rule, scope: R-002, decision: same_as }',
      '  R-005: { kind: rule, release: mvp }',
      '  R-006: { kind: rule, scope: R-002, defect: D-5 }',
      '',
    ].join('\n');
    const reg = messages(run('', registry(atoms)), 'REG').join('\n');
    expect(reg).toContain('R-001: kind');
    expect(reg).toContain('R-002: неизвестное поле color');
    expect(reg).toContain('R-003: decision: rejected требует note');
    expect(reg).toContain('R-004: decision: same_as без same_as');
    expect(reg).toContain('R-005: release бывает только у атома вида scope');
    expect(reg).toContain('R-006: defect ставится только на открытый clarify');
  });

  it('дубль номера в YAML не проходит молча', () => {
    const reg = messages(run('{R-001} a', registry(`${SCOPE}${SCOPE}`)), 'REG');
    expect(reg[0]).toContain('YAML не разбирается');
  });

  it('у термина глоссария одно значение', () => {
    const reg = messages(run('{R-001} a', registry(SCOPE, 'glossary:\n  ветка: [topic, branch]\n')), 'REG');
    expect(reg).toEqual(['glossary.ветка: у термина одно значение — непустая строка']);
  });
});

describe('GATE: готовность ТЗ к шагу 1', () => {
  const atoms = [
    '  R-001: { kind: scope, release: mvp }',
    '  R-002: { kind: scope, release: later }',
    '  R-003: { kind: rule, scope: R-001, decision: clarify, defect: D-5, note: противоречие в MVP }',
    '  R-004: { kind: rule, scope: R-002, decision: clarify, defect: D-5, note: противоречие вне MVP }',
    '  R-005: { kind: view, scope: R-002, decision: clarify, defect: D-1, note: нет релиза }',
    '  R-006: { kind: rule, decision: clarify, note: пункта объёма нет }',
    '',
  ].join('\n');
  const markdown = ['{R-001} a', '{R-002} b', '{R-003} c', '{R-004} d', '{R-005} e', '{R-006} f'].join('\n\n');

  it('блокируют clarify в MVP, без релиза и D-1 / D-3 в любом релизе', () => {
    const gate = messages(run(markdown, registry(atoms), true), 'GATE');
    expect(gate.map((m) => m.split(' ')[0])).toEqual(['R-003', 'R-005', 'R-006']);
  });

  it('на шаге 0 gate не проверяется', () => {
    expect(messages(run(markdown, registry(atoms)), 'GATE')).toEqual([]);
  });
});

describe('PDA: колонка «Из ТЗ»', () => {
  const atoms = [
    '  R-001: { kind: scope, release: mvp }',
    '  R-002: { kind: rule, scope: R-001 }',
    '  R-003: { kind: rule, scope: R-001, decision: withdrawn, note: снят }',
    '',
  ].join('\n');
  const tz = '{R-001} a\n\n{R-002} b';
  const table = (rows: string[]): string => ['| ID | Неопределённость | Из ТЗ |', '| --- | --- | --- |', ...rows].join('\n');
  const runPda = (text: string): Finding[] =>
    check(registry(atoms), () => tz, { gate: false }, [{ file: 'docs/pda/01.md', text }]).findings;

  it('читает ID и ссылки только из таблиц с колонкой «Из ТЗ»', () => {
    const text = [
      table(['| U-1 | что сделано? | R-002, R-001 |', '| U-2 | кто? | derived: повтор доставки |']),
      '',
      '| ID | Без ссылок |',
      '| --- | --- |',
      '| X-1 | мимо |',
    ].join('\n');
    const elements = parsePdaElements({ file: 'f.md', text });
    expect(elements.map((e) => [e.id, e.line, e.refs, e.derived])).toEqual([
      ['U-1', 3, ['R-002', 'R-001'], false],
      ['U-2', 4, [], true],
    ]);
  });

  it('TR-5: элемент без ссылок и без derived', () => {
    expect(messages(runPda(table(['| U-1 | что? | — |'])), 'TR-5')).toEqual([
      'docs/pda/01.md:3: U-1 не ссылается на атомы ТЗ; решение архитектуры помечается «derived: причина»',
    ]);
  });

  it('TR-2: ссылка на несуществующий и отозванный атом, дубль ID', () => {
    const tr2 = messages(runPda(table(['| U-1 | a | R-009 |', '| U-1 | b | R-003 |'])), 'TR-2').join('\n');
    expect(tr2).toContain('U-1 → R-009: такого атома нет');
    expect(tr2).toContain('U-1 → R-003: атом отозван');
    expect(tr2).toContain('U-1 определён дважды');
  });

  it('корректная таблица проходит', () => {
    const findings = runPda(table(['| U-1 | a | R-002 |']));
    expect(findings.filter((f) => f.rule === 'TR-2' || f.rule === 'TR-5')).toEqual([]);
  });
});

describe('Реестр событий', () => {
  const atoms = ['  R-001: { kind: scope, release: mvp }', '  R-002: { kind: reaction, scope: R-001 }', ''].join('\n');
  const tz = '{R-001} a\n\n{R-002} b';
  const event = (extra: string): string =>
    [
      'events:',
      '  - type: task.created',
      '    version: 1',
      '    context: tasks',
      '    actor: assignee',
      '    subject: Task',
      '    payload: { task_id: string }',
      '    idempotency_key: update_id',
      '    owner: max',
      extra,
    ].join('\n');
  const pda = [
    '| ID | Акт | Порождает событие | Из ТЗ |',
    '| --- | --- | --- | --- |',
    '| A-1 | завести | `task.created`, `task.lost` | R-002 |',
    '',
    '| ID | Формулировка | Из ТЗ |',
    '| --- | --- | --- |',
    '| INV-01 | закон | derived: пример |',
    '| P-1 | проекция | derived: пример |',
  ].join('\n');
  const run = (registryText: string): Finding[] =>
    check(registry(atoms), () => tz, { gate: false }, [{ file: 'p.md', text: pda }], registryText).findings;

  it('событие с realizes покрывает reaction', () => {
    const text = event('    invariants: [INV-01]\n    realizes: [R-002]');
    const result = check(registry(atoms), () => tz, { gate: false }, [], text);
    expect(coverage(result.registry, result.elements).map((r) => [r.id, r.status, r.refs])).toEqual([['R-002', 'covered', ['EV-task.created']]]);
  });

  it('событие из таблицы актов обязано быть в реестре, инварианты и проекции события — в PDA', () => {
    const tr2 = messages(run(event('    invariants: [INV-01, INV-99]\n    projections: [P-1, P-9]\n    realizes: [R-002]')), 'TR-2').join('\n');
    expect(tr2).toContain('A-1 → событие task.lost: его нет в реестре');
    expect(tr2).toContain('task.created → INV-99: такого инварианта нет');
    expect(tr2).toContain('task.created → P-9: такой проекции нет');
    expect(tr2).not.toContain('task.created: его нет');
    expect(tr2).not.toContain('P-1: такой');
  });

  it('контекст события — из графа домена', () => {
    const graph = ['| ID | Сущность | Контекст | Из ТЗ |', '| --- | --- | --- | --- |', '| E-1 | Задача | `tasks` | derived: пример |'].join('\n');
    const findings = (context: string): string[] =>
      messages(
        check(registry(atoms), () => tz, { gate: false }, [{ file: 'g.md', text: graph }], event('    invariants: []\n    realizes: [R-002]').replace('context: tasks', `context: ${context}`)).findings,
        'TR-2',
      );
    expect(findings('tasks')).toEqual([]);
    expect(findings('reports')).toEqual(['contracts/event-registry.yaml: task.created → контекст reports: его нет в графе домена']);
  });

  it('обязательные поля и realizes', () => {
    const { elements, findings } = parseEventRegistry('events:\n  - type: task.checked\n    version: 1\n');
    expect(findings.map((f) => f.message).join('\n')).toContain('task.checked — нет полей context, actor, subject, payload, idempotency_key, invariants, owner');
    expect(messages(check(registry(atoms), () => tz, { gate: false }, [], 'events:\n  - type: x.y\n').findings, 'TR-5')[0]).toContain('EV-x.y не ссылается на атомы ТЗ');
    expect(elements.map((e) => e.id)).toEqual(['EV-task.checked']);
  });
});

describe('TR-4: покрытие по правилу вида', () => {
  const atoms = [
    '  R-001: { kind: scope, release: mvp }',
    '  R-002: { kind: scope, release: later }',
    '  R-003: { kind: act, scope: R-001 }',
    '  R-004: { kind: act, scope: R-001 }',
    '  R-005: { kind: act, scope: R-001 }',
    '  R-006: { kind: act, scope: R-001, decision: same_as, same_as: R-003 }',
    '  R-007: { kind: act, scope: R-002, decision: deferred }',
    '  R-008: { kind: rule, scope: R-001 }',
    '',
  ].join('\n');
  const tz = ['{R-001} a', '{R-002} b', '{R-003} c', '{R-004} d', '{R-005} e', '{R-006} f', '{R-007} g', '{R-008} h'].join('\n\n');
  const pda = [
    '| ID | Что | Из ТЗ |',
    '| --- | --- | --- |',
    '| U-1 | неопределённость | R-004 |',
    '| A-1 | акт | R-003, R-008 |',
  ].join('\n');

  it('узел графа покрывает поле схемы по имени, без ссылки', () => {
    const fieldAtoms = ['  R-001: { kind: scope, release: mvp }', '  R-002: { kind: entity, scope: R-001 }', '  R-003: { kind: entity, scope: R-001 }', ''].join('\n');
    const schema = ['### users', '', '- {R-001} `id`;', '- {R-002} `telegram_user_id`;', '- {R-003} `name`.'].join('\n');
    const graph = [
      '| ID | Сущность | Таблица | Поля | Из ТЗ |',
      '| --- | --- | --- | --- | --- |',
      '| E-1 | Пользователь | `users` | `id`, `telegram_user_id` | derived: пример |',
    ].join('\n');
    const result = check(registry(fieldAtoms), () => schema, { gate: false }, [{ file: 'g.md', text: graph }]);
    expect(coverage(result.registry, result.elements, atomTexts(result.blocks)).map((r) => [r.id, r.status, r.refs])).toEqual([
      ['R-002', 'covered', ['E-1']],
      ['R-003', 'orphan', []],
    ]);
  });

  it('акт покрывает act, неопределённость — нет; повторы, отложенное и scope не считаются', () => {
    const result = check(registry(atoms), () => tz, { gate: false }, [{ file: 'p.md', text: pda }]);
    const rows = coverage(result.registry, result.elements);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['R-003', 'covered'],
      ['R-004', 'partial'],
      ['R-005', 'orphan'],
      ['R-008', 'partial'],
    ]);
  });

  it('на выходе из PDA непокрытый атом MVP блокирует, без флага — только отчёт', () => {
    expect(messages(check(registry(atoms), () => tz, { gate: false }, [{ file: 'p.md', text: pda }]).findings, 'TR-4')).toEqual([]);
    const result = check(registry(atoms), () => tz, { gate: false, pda: true }, [{ file: 'p.md', text: pda }]);
    expect(messages(result.findings, 'TR-4')).toEqual([
      'R-004 partial · act: нужен элемент A, есть только U-1',
      'R-005 orphan · act: нужен элемент A',
      'R-008 partial · rule: нужен элемент INV или E или L, есть только A-1',
    ]);
  });
});

describe('Backlog: TR-7, TR-8 и ссылки issues', () => {
  const acts = Array.from({ length: MAX_ATOMS_PER_STEP + 1 }, (_, i) => `R-${String(i + 3).padStart(3, '0')}`);
  const later = `R-${String(acts.length + 3).padStart(3, '0')}`;
  const atoms = [
    '  R-001: { kind: scope, release: mvp }',
    '  R-002: { kind: scope, release: later }',
    ...acts.map((id) => `  ${id}: { kind: act, scope: R-001 }`),
    `  ${later}: { kind: act, scope: R-002 }`,
    '',
  ].join('\n');
  const tz = ['R-001', 'R-002', ...acts, later].map((id) => `{${id}} текст ${id}`).join('\n\n');
  const pda = ['| ID | Что | Из ТЗ |', '| --- | --- | --- |', `| A-1 | акт | ${acts.join(', ')} |`, '| INV-01 | закон | derived: пример |'].join('\n');
  const issue = (id: string, items: string[], meta: string[] = [], elements = 'A-1 · INV-01'): { file: string; text: string } => ({
    file: `docs/backlog/${id}.md`,
    text: ['---', `id: ${id}`, `title: "${id}"`, ...meta, '---', '', '## PDA', '', elements, '', '## Атомы ТЗ', '', ...items.map((item) => `- [${item.startsWith('x:') ? 'x' : ' '}] ${item.replace('x:', '')} — метка`), ''].join('\n'),
  });
  const index = (ids: string[]): string => ids.map((id) => `| [${id}](${id}.md) |`).join('\n');
  const findings = (issues: { file: string; text: string }[], listed = issues.map((i) => i.file.slice(13, -3))): Finding[] =>
    check(registry(atoms), () => tz, { gate: false }, [{ file: 'p.md', text: pda }], undefined, { issues, index: index(listed) }).findings;

  it('разбирает front matter, чек-лист атомов и элементы PDA', () => {
    const { issue: parsed } = parseIssue(issue('I-07', ['x:R-003', 'R-004'], ['state: closed', 'blocked_by: [I-01]'], 'A-1 · INV-01 · события `task.created`'));
    expect(parsed).toMatchObject({ id: 'I-07', closed: true, blockedBy: ['I-01'], elements: ['A-1', 'INV-01', 'EV-task.created'] });
    expect(parsed?.atoms.map((a) => [a.id, a.done])).toEqual([
      ['R-003', true],
      ['R-004', false],
    ]);
    expect(parseIssue({ file: 'x.md', text: '# без front matter' }).findings[0]?.message).toBe('x.md: нет front matter');
  });

  it('TR-7: покрытый атом MVP назначен issue; атом вне MVP, пункт объёма и отложенное в issue не входят', () => {
    const tr7 = messages(findings([issue('I-01', acts.slice(0, -1)), issue('I-02', ['R-001', later])]), 'TR-7');
    expect(tr7).toEqual([
      'docs/backlog/I-02.md:12: R-001 — пункт объёма работ, в issue не назначается',
      `docs/backlog/I-02.md:13: ${later} не входит в MVP`,
      `${acts.at(-1)} act покрыт в PDA, но не назначен ни одной issue`,
    ]);
    expect(messages(findings([issue('I-01', acts.slice(0, 5)), issue('I-02', acts.slice(5))]), 'TR-7')).toEqual([]);
  });

  it('TR-7: у закрытой issue отмечены все атомы', () => {
    const closed = issue('I-01', ['x:R-003', 'R-004'], ['state: closed']);
    expect(messages(findings([closed, issue('I-02', acts.slice(2))]), 'TR-7')).toEqual(['docs/backlog/I-01.md:14: I-01 закрыта, а R-004 не отмечен']);
  });

  it(`TR-8: атомов в issue не больше ${MAX_ATOMS_PER_STEP}`, () => {
    expect(messages(findings([issue('I-01', acts)]), 'TR-8')).toEqual([
      `docs/backlog/I-01.md: I-01 — атомов ${acts.length}, лимит ${MAX_ATOMS_PER_STEP}; режется по атомам, а не по слоям`,
    ]);
  });

  it('TR-2: элементы PDA, blocked_by без круга, каталог совпадает с файлами', () => {
    const issues = [issue('I-01', acts.slice(0, 5), ['blocked_by: [I-02]'], 'A-7'), issue('I-02', acts.slice(5), ['blocked_by: [I-01, I-09]'])];
    expect(messages(findings(issues, ['I-01', 'I-05']), 'TR-2')).toEqual([
      'docs/backlog/I-01.md: I-01 → A-7: такого элемента PDA нет',
      'docs/backlog/I-02.md: I-02 blocked_by I-09: такой issue нет',
      'blocked_by по кругу: I-01 → I-02 → I-01',
      'docs/backlog/README.md: нет строки I-02',
      'docs/backlog/README.md: I-05 — файла нет',
    ]);
  });

  it('tz:trace: атом → элементы PDA → issues → тесты', () => {
    const result = check(registry(atoms), () => tz, { gate: false }, [{ file: 'p.md', text: pda }], undefined, {
      issues: [issue('I-01', ['x:R-003', ...acts.slice(1, 5)]), issue('I-02', ['R-003', ...acts.slice(5)])],
    });
    expect(formatTrace(result, ['R-003'], new Map()).split('\n')).toEqual(['R-003  §  covered', '  «текст R-003»', '  → A-1', '  → I-01 ✓, I-02', '  → —']);
  });
});
