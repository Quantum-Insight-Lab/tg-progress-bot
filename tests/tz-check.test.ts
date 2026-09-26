import { describe, expect, it } from 'vitest';
import { atomTexts, check, coverage, parsePdaElements, splitBlocks, type Finding, type Rule } from '../scripts/tz-check.ts';

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
});
