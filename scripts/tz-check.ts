import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { TESTS_DIR, testIds } from './check-invariants.ts';

export const KINDS = ['rule', 'act', 'reaction', 'entity', 'view', 'integration', 'tech', 'metric', 'scope'] as const;
export const RELEASES = ['mvp', 'later', 'out'] as const;
export const DECISIONS = ['deferred', 'rejected', 'same_as', 'clarify', 'withdrawn'] as const;
export const DEFECTS = ['D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6'] as const;

export type Kind = (typeof KINDS)[number];
export type Release = (typeof RELEASES)[number];
export type Decision = (typeof DECISIONS)[number];
export type Defect = (typeof DEFECTS)[number];

export interface Atom {
  kind: Kind;
  release?: Release;
  scope?: string;
  decision?: Decision;
  same_as?: string;
  defect?: Defect;
  note?: string;
}

export interface Registry {
  source: string;
  glossary: Record<string, string>;
  atoms: Map<string, Atom>;
}

export interface Section {
  title: string;
  line: number;
}

export interface Block {
  line: number;
  section: Section;
  text: string;
}

export interface SectionReport {
  section: Section;
  blocks: number;
  anchored: number;
  started: boolean;
}

export type Rule = 'TR-1' | 'TR-2' | 'TR-3' | 'TR-4' | 'TR-5' | 'TR-7' | 'TR-8' | 'REG' | 'GATE';

export interface Finding {
  rule: Rule;
  message: string;
}

export interface PdaDoc {
  file: string;
  text: string;
}

/** Строка таблицы PDA с колонкой «Из ТЗ»: элемент (U-1, A-3, INV-02…) и атомы, из которых он выведен. */
export interface PdaElement {
  id: string;
  file: string;
  line: number;
  refs: string[];
  derived: boolean;
  cells: Record<string, string>;
}

export interface CheckResult {
  gate: boolean;
  /** Выход из PDA: TR-4 блокирует, а не только отчитывается. */
  pda: boolean;
  source: string;
  blocks: Block[];
  sections: SectionReport[];
  anchors: Map<string, number[]>;
  registry: Registry;
  elements: PdaElement[];
  /** null — backlog ещё не нарезан, TR-7 и TR-8 не проверяются. */
  issues: Issue[] | null;
  findings: Finding[];
}

/** Issue backlog (патч 1.3, 10.8): ссылается на атомы — чек-лист «Атомы ТЗ» — и на элементы PDA. */
export interface Issue {
  id: string;
  file: string;
  title: string;
  milestone?: string;
  labels: string[];
  /** Номер issue на GitHub после публикации. */
  github?: number;
  closed: boolean;
  blockedBy: string[];
  atoms: { id: string; done: boolean; line: number }[];
  elements: string[];
}

export const REGISTRY_PATH = 'contracts/tz-registry.yaml';
export const PDA_DIR = 'docs/pda';
const FROM_TZ_COLUMN = 'Из ТЗ';
const ELEMENT_ID = /^[A-Z]+-\d+$/;

/**
 * Правило вида (10.4): атом покрывает только элемент PDA своего вида, по префиксу ID.
 * A — акт, INV — инвариант, E/L — узел и связь графа, P — проекция или экран, B — решение blueprint, M — метрика.
 * События покрывают reaction и integration через `realizes` в реестре событий (шаг 6).
 */
export const COVERED_BY: Readonly<Record<Kind, readonly string[]>> = {
  act: ['A'],
  reaction: ['A', 'EV'],
  rule: ['INV', 'E', 'L'],
  entity: ['E', 'L'],
  view: ['P'],
  integration: ['B', 'EV'],
  tech: ['B'],
  metric: ['M'],
  scope: [],
};

export const BACKLOG_DIR = 'docs/backlog';
export const BACKLOG_INDEX = 'README.md';
/** 10.11: без данных ретрофита — 10, допустимо 5–25; калибруется по underdelivery_rate (M-23). Карточка — docs/backlog/README.md. */
export const MAX_ATOMS_PER_STEP = 10;
const ISSUE_ID = /^I-\d{2,}$/;
const ISSUE_ATOM = /^- \[( |x|X)\] (R-\d{3,})\b/;
const ISSUE_ELEMENT = /\b(?:U|A|E|L|INV|C|B|P|M|S)-\d+\b/g;

export const EVENT_REGISTRY_PATH = 'contracts/event-registry.yaml';
const EVENT_FIELDS = ['type', 'version', 'context', 'actor', 'subject', 'payload', 'idempotency_key', 'invariants', 'owner'] as const;
const ACT_EVENT_COLUMN = 'Порождает событие';
const CONTEXT_COLUMN = 'Контекст';

/** События реестра — элементы PDA с префиксом EV: `realizes` — их ссылки на атомы (патч 1.3, 10.8). */
export function parseEventRegistry(text: string, file = EVENT_REGISTRY_PATH): { elements: PdaElement[]; findings: Finding[] } {
  const elements: PdaElement[] = [];
  const findings: Finding[] = [];
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (error) {
    findings.push({ rule: 'TR-2', message: `${file}: YAML не разбирается: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` });
    return { elements, findings };
  }
  const events = isRecord(root) && Array.isArray(root.events) ? root.events : [];
  for (const [index, value] of events.entries()) {
    if (!isRecord(value) || typeof value.type !== 'string') {
      findings.push({ rule: 'TR-2', message: `${file}: событие №${index + 1} без type` });
      continue;
    }
    const missing = EVENT_FIELDS.filter((field) => value[field] === undefined);
    if (missing.length > 0) findings.push({ rule: 'TR-2', message: `${file}: ${value.type} — нет полей ${missing.join(', ')}` });
    const refs = Array.isArray(value.realizes) ? value.realizes.filter((ref): ref is string => typeof ref === 'string') : [];
    const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
    elements.push({
      id: `EV-${value.type}`,
      file,
      line: index + 1,
      refs,
      derived: typeof value.derived === 'string' && value.derived.trim() !== '',
      cells: {
        context: typeof value.context === 'string' ? value.context : '',
        invariants: strings(value.invariants).join(', '),
        projections: strings(value.projections).join(', '),
      },
    });
  }
  return { elements, findings };
}

/** TR-2 между PDA и реестром: события из таблицы актов существуют; контексты, инварианты и проекции событий определены в PDA. */
export function checkEventLinks(elements: PdaElement[]): Finding[] {
  const findings: Finding[] = [];
  const events = new Set(elements.filter((e) => e.id.startsWith('EV-')).map((e) => e.id.slice(3)));
  const invariants = new Set(elements.filter((e) => e.id.startsWith('INV-')).map((e) => e.id));
  const projections = new Set(elements.filter((e) => e.id.startsWith('P-')).map((e) => e.id));
  const contexts = new Set(elements.filter((e) => e.id.startsWith('E-')).flatMap((e) => backticked(e.cells[CONTEXT_COLUMN])));
  if (events.size === 0) return findings;
  for (const element of elements) {
    if (element.id.startsWith('A-')) {
      for (const name of backticked(element.cells[ACT_EVENT_COLUMN])) {
        if (!events.has(name)) findings.push({ rule: 'TR-2', message: `${element.file}:${element.line}: ${element.id} → событие ${name}: его нет в реестре` });
      }
    }
    if (element.id.startsWith('EV-')) {
      const context = element.cells.context ?? '';
      if (contexts.size > 0 && !contexts.has(context)) {
        findings.push({ rule: 'TR-2', message: `${element.file}: ${element.id.slice(3)} → контекст ${context || '(пусто)'}: его нет в графе домена` });
      }
      for (const inv of (element.cells.invariants ?? '').split(', ').filter(Boolean)) {
        if (!invariants.has(inv)) findings.push({ rule: 'TR-2', message: `${element.file}: ${element.id.slice(3)} → ${inv}: такого инварианта нет` });
      }
      for (const projection of (element.cells.projections ?? '').split(', ').filter(Boolean)) {
        if (!projections.has(projection)) {
          findings.push({ rule: 'TR-2', message: `${element.file}: ${element.id.slice(3)} → ${projection}: такой проекции нет` });
        }
      }
    }
  }
  return findings;
}

export type Coverage = 'covered' | 'partial' | 'orphan';

export interface CoverageRow {
  id: string;
  kind: Kind;
  status: Coverage;
  refs: string[];
}

const ANCHOR_AT_START = /^\{(?:R-\d{3,}|ctx)\}/;
const ANY_ANCHOR = /\{(?:R-\d{3,}|ctx)\}/;
const ATOM_ANCHORS = /\{(R-\d{3,})\}/g;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const ROOT_KEYS = new Set(['source', 'glossary', 'atoms']);
const ATOM_KEYS = new Set(['kind', 'release', 'scope', 'decision', 'same_as', 'defect', 'note']);
const NOTE_REQUIRED: ReadonlySet<Decision> = new Set(['rejected', 'clarify', 'withdrawn']);
const DEFECTS_BLOCKING_ANY_RELEASE: ReadonlySet<Defect> = new Set(['D-1', 'D-3']);

export function formatId(n: number): string {
  return `R-${String(n).padStart(3, '0')}`;
}

function idNumber(id: string): number | null {
  const match = /^R-(\d{3,})$/.exec(id);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 && formatId(n) === id ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function preview(text: string): string {
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

/**
 * Блок — единица покрытия (10.5, правило 1): абзац, пункт списка, строка цитаты, строка таблицы.
 * Заголовки и разделители блоками не считаются. Блок кода считается одним блоком, якорь — в первой строке.
 */
export function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let section: Section = { title: '', line: 0 };
  let open: Block | null = null;
  let fence: string | null = null;
  let fenceAwaitsText = false;

  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    const line = index + 1;
    const text = raw.trim();

    if (fence !== null) {
      if (text.startsWith(fence)) fence = null;
      else if (fenceAwaitsText && text !== '') {
        blocks.push({ line, section, text });
        fenceAwaitsText = false;
      }
      continue;
    }
    const fenceOpen = /^(`{3,}|~{3,})/.exec(text);
    if (fenceOpen?.[1]) {
      fence = fenceOpen[1];
      fenceAwaitsText = true;
      open = null;
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(text);
    if (heading?.[1]) {
      section = { title: heading[1].trim(), line };
      open = null;
      continue;
    }
    if (text === '' || /^([-*_])(\s*\1){2,}$/.test(text)) {
      open = null;
      continue;
    }
    if (text.startsWith('>')) {
      open = null;
      const inner = text.replace(/^(?:>\s?)+/, '').trim();
      if (inner !== '') blocks.push({ line, section, text: LIST_ITEM.exec(inner)?.[1]?.trim() ?? inner });
      continue;
    }
    if (text.startsWith('|')) {
      open = null;
      const delimiterRow = /^[|:\-\s]+$/.test(text);
      if (!delimiterRow) blocks.push({ line, section, text: text.slice(1).trim() });
      continue;
    }
    const item = LIST_ITEM.exec(text);
    if (item) {
      open = { line, section, text: (item[1] ?? '').trim() };
      blocks.push(open);
      continue;
    }
    if (open) {
      open.text = `${open.text} ${text}`;
      continue;
    }
    open = { line, section, text };
    blocks.push(open);
  }
  return blocks;
}

export function collectAnchors(markdown: string): Map<string, number[]> {
  const anchors = new Map<string, number[]>();
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    for (const match of raw.matchAll(ATOM_ANCHORS)) {
      const id = match[1] ?? '';
      anchors.set(id, [...(anchors.get(id) ?? []), index + 1]);
    }
  }
  return anchors;
}

export function parseRegistry(text: string): { registry: Registry; findings: Finding[] } {
  const findings: Finding[] = [];
  const report = (message: string): void => {
    findings.push({ rule: 'REG', message });
  };
  const registry: Registry = { source: '', glossary: {}, atoms: new Map() };

  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (error) {
    report(`YAML не разбирается: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return { registry, findings };
  }
  if (!isRecord(root)) {
    report('реестр — YAML-объект с полями source, glossary, atoms');
    return { registry, findings };
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) report(`неизвестное поле верхнего уровня: ${key}`);
  }
  if (typeof root.source === 'string' && root.source !== '') registry.source = root.source;
  else report('source: путь к ТЗ обязателен');

  if (root.glossary !== undefined && root.glossary !== null) {
    if (!isRecord(root.glossary)) report('glossary: ожидается «термин: значение»');
    else {
      for (const [term, meaning] of Object.entries(root.glossary)) {
        if (typeof meaning === 'string' && meaning.trim() !== '') registry.glossary[term] = meaning;
        else report(`glossary.${term}: у термина одно значение — непустая строка`);
      }
    }
  }

  if (!isRecord(root.atoms)) {
    report('atoms: ожидается «R-001: { kind: … }»');
    return { registry, findings };
  }
  for (const [id, value] of Object.entries(root.atoms)) {
    const atom = parseAtom(id, value, report);
    if (atom) registry.atoms.set(id, atom);
  }
  return { registry, findings };
}

function parseAtom(id: string, value: unknown, report: (message: string) => void): Atom | null {
  if (idNumber(id) === null) {
    report(`${id}: номер атома пишется R-001, R-002…`);
    return null;
  }
  if (!isRecord(value)) {
    report(`${id}: ожидается объект { kind, … }`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!ATOM_KEYS.has(key)) report(`${id}: неизвестное поле ${key}`);
  }
  const kind = oneOf(KINDS, value.kind);
  if (!kind) {
    report(`${id}: kind — одно из ${KINDS.join(', ')}`);
    return null;
  }
  const atom: Atom = { kind };

  if (value.release !== undefined) {
    const release = oneOf(RELEASES, value.release);
    if (!release) report(`${id}: release — одно из ${RELEASES.join(', ')}`);
    else if (kind !== 'scope') report(`${id}: release бывает только у атома вида scope, остальные ссылаются на него через scope`);
    else atom.release = release;
  }
  if (value.scope !== undefined) {
    if (typeof value.scope === 'string' && idNumber(value.scope) !== null) atom.scope = value.scope;
    else report(`${id}: scope — номер атома вида scope`);
  }
  if (value.decision !== undefined) {
    const decision = oneOf(DECISIONS, value.decision);
    if (decision) atom.decision = decision;
    else report(`${id}: decision — одно из ${DECISIONS.join(', ')}`);
  }
  if (value.same_as !== undefined) {
    if (atom.decision !== 'same_as') report(`${id}: same_as указывается вместе с decision: same_as`);
    else if (typeof value.same_as === 'string' && idNumber(value.same_as) !== null) atom.same_as = value.same_as;
    else report(`${id}: same_as — номер атома`);
  } else if (atom.decision === 'same_as') report(`${id}: decision: same_as без same_as — повтор чего?`);
  if (value.defect !== undefined) {
    const defect = oneOf(DEFECTS, value.defect);
    if (!defect) report(`${id}: defect — одно из ${DEFECTS.join(', ')}`);
    else if (atom.decision !== 'clarify') report(`${id}: defect ставится только на открытый clarify`);
    else atom.defect = defect;
  }
  if (value.note !== undefined) {
    if (typeof value.note === 'string' && value.note.trim() !== '') atom.note = value.note.trim();
    else report(`${id}: note — непустая строка`);
  }
  if (atom.decision && NOTE_REQUIRED.has(atom.decision) && atom.note === undefined) {
    report(`${id}: decision: ${atom.decision} требует note — причину или вопрос`);
  }
  return atom;
}

/** TR-1. На шаге 0 раздел размечается целиком за проход: раздел без единого якоря — ещё не начат. */
export function checkBlocks(blocks: Block[], gate: boolean): { findings: Finding[]; sections: SectionReport[] } {
  const bySection = new Map<number, { section: Section; blocks: Block[] }>();
  for (const block of blocks) {
    const entry = bySection.get(block.section.line) ?? { section: block.section, blocks: [] };
    entry.blocks.push(block);
    bySection.set(block.section.line, entry);
  }
  const findings: Finding[] = [];
  const sections: SectionReport[] = [];
  for (const { section, blocks: own } of bySection.values()) {
    const bare = own.filter((block) => !ANCHOR_AT_START.test(block.text));
    const started = own.some((block) => ANY_ANCHOR.test(block.text));
    sections.push({ section, blocks: own.length, anchored: own.length - bare.length, started });
    if (!started && !gate) continue;
    for (const block of bare) {
      findings.push({ rule: 'TR-1', message: `стр. ${block.line}: блок не начинается с якоря — «${preview(block.text)}»` });
    }
  }
  return { findings, sections };
}

/** TR-2. Номера уникальны, сквозные и не переиспользуются; якоря и реестр совпадают 1:1; ссылки не висят. */
export function checkIds(anchors: Map<string, number[]>, registry: Registry): Finding[] {
  const findings: Finding[] = [];
  const report = (message: string): void => {
    findings.push({ rule: 'TR-2', message });
  };

  for (const [id, lines] of anchors) {
    if (idNumber(id) === null) report(`стр. ${lines.join(', ')}: ${id} — номер пишется R-001, R-002…`);
    if (lines.length > 1) report(`${id} стоит на нескольких местах: стр. ${lines.join(', ')}; повтор требования — новый атом с same_as`);
    const atom = registry.atoms.get(id);
    if (!atom) report(`${id} (стр. ${lines[0]}) нет в реестре`);
    else if (atom.decision === 'withdrawn') report(`${id} отозван, но якорь остался: стр. ${lines.join(', ')}`);
  }

  for (const [id, atom] of registry.atoms) {
    if (atom.decision !== 'withdrawn' && !anchors.has(id)) {
      report(`${id} есть в реестре, но нет в ТЗ; удалённый атом остаётся в реестре с decision: withdrawn`);
    }
    for (const [field, target] of [['scope', atom.scope], ['same_as', atom.same_as]] as const) {
      if (target === undefined) continue;
      const referenced = registry.atoms.get(target);
      if (!referenced) report(`${id}.${field} → ${target}: такого атома нет`);
      else if (referenced.decision === 'withdrawn') report(`${id}.${field} → ${target}: атом отозван`);
    }
  }

  const numbers = [...registry.atoms.keys()].map(idNumber).filter((n): n is number => n !== null);
  const max = Math.max(0, ...numbers);
  for (let n = 1; n <= max; n += 1) {
    const id = formatId(n);
    if (!registry.atoms.has(id)) report(`${id} пропущен: номера сквозные, удалённый атом остаётся в реестре с decision: withdrawn`);
  }
  return findings;
}

/** TR-3. Релиз атома доказывается ссылкой на пункт объёма работ, а не назначается. */
export function checkScope(registry: Registry): Finding[] {
  const findings: Finding[] = [];
  const report = (message: string): void => {
    findings.push({ rule: 'TR-3', message });
  };

  for (const [id, atom] of registry.atoms) {
    if (atom.decision === 'withdrawn') continue;
    if (atom.decision === 'same_as' && atom.same_as) {
      const original = registry.atoms.get(atom.same_as);
      if (original && original.kind !== atom.kind) report(`${id}: повтор ${atom.same_as}, но вид другой — ${atom.kind} против ${original.kind}`);
      if (original && atom.kind === 'scope' && original.release !== atom.release) {
        report(`${id}: повтор ${atom.same_as}, но релиз другой — ${atom.release ?? '—'} против ${original.release ?? '—'}`);
      }
    }
    if (atom.kind === 'scope') {
      if (atom.scope !== undefined) report(`${id}: атом вида scope сам задаёт релиз и не ссылается на scope`);
      if (atom.release === undefined && atom.decision !== 'clarify') report(`${id}: у атома вида scope нет release (${RELEASES.join(' | ')})`);
      continue;
    }
    if (atom.scope === undefined) {
      if (atom.decision !== 'clarify') report(`${id}: нет scope; нет пункта объёма работ — decision: clarify, а не релиз на глаз`);
      continue;
    }
    const target = registry.atoms.get(atom.scope);
    if (!target) continue;
    if (target.kind !== 'scope') report(`${id}.scope → ${atom.scope}: это атом вида ${target.kind}, а не scope`);
    else if (atom.decision === 'deferred' && target.release === 'mvp') report(`${id}: deferred, но scope ${atom.scope} — MVP`);
  }
  return findings;
}

export function releaseOf(atom: Atom, registry: Registry): Release | null {
  if (atom.kind === 'scope') return atom.release ?? null;
  const target = atom.scope === undefined ? undefined : registry.atoms.get(atom.scope);
  return target?.kind === 'scope' ? (target.release ?? null) : null;
}

/** Gate готовности ТЗ к шагу 1 (10.10): нет D-1 и D-3, в атомах MVP и без релиза — ни одного открытого clarify. */
export function checkGate(registry: Registry): Finding[] {
  const findings: Finding[] = [];
  for (const [id, atom] of registry.atoms) {
    if (atom.decision !== 'clarify') continue;
    const release = releaseOf(atom, registry);
    const blocking = release === null || release === 'mvp' || (atom.defect !== undefined && DEFECTS_BLOCKING_ANY_RELEASE.has(atom.defect));
    if (blocking) {
      findings.push({ rule: 'GATE', message: `${id} ${atom.defect ?? 'clarify'} (${release ?? 'релиз не доказан'}): ${atom.note ?? ''}` });
    }
  }
  return findings;
}

function tableCells(row: string): string[] {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** Элементы PDA — строки таблиц, где есть колонка «Из ТЗ», а первая ячейка — ID вида U-1. */
export function parsePdaElements(doc: PdaDoc): PdaElement[] {
  const elements: PdaElement[] = [];
  let header: string[] | null = null;
  for (const [index, raw] of doc.text.split(/\r?\n/).entries()) {
    const text = raw.trim();
    if (!text.startsWith('|')) {
      header = null;
      continue;
    }
    if (header === null) {
      header = tableCells(text);
      continue;
    }
    const refColumn = header.indexOf(FROM_TZ_COLUMN);
    const cells = tableCells(text);
    const id = cells[0] ?? '';
    if (refColumn < 0 || !ELEMENT_ID.test(id)) continue;
    const refs = cells[refColumn] ?? '';
    elements.push({
      id,
      file: doc.file,
      line: index + 1,
      refs: [...refs.matchAll(/R-\d{3,}/g)].map((match) => match[0]),
      derived: refs.includes('derived:'),
      cells: Object.fromEntries(header.map((name, column) => [name, cells[column] ?? ''])),
    });
  }
  return elements;
}

/** TR-2 для ссылок из PDA и TR-5: элемент ссылается на атомы или помечен «derived: причина». */
export function checkPda(elements: PdaElement[], registry: Registry): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, PdaElement>();
  for (const element of elements) {
    const where = `${element.file}:${element.line}`;
    const first = seen.get(element.id);
    if (first) findings.push({ rule: 'TR-2', message: `${element.id} определён дважды: ${first.file}:${first.line} и ${where}` });
    else seen.set(element.id, element);
    if (element.refs.length === 0 && !element.derived) {
      findings.push({ rule: 'TR-5', message: `${where}: ${element.id} не ссылается на атомы ТЗ; решение архитектуры помечается «derived: причина»` });
    }
    for (const ref of element.refs) {
      const atom = registry.atoms.get(ref);
      if (!atom) findings.push({ rule: 'TR-2', message: `${where}: ${element.id} → ${ref}: такого атома нет` });
      else if (atom.decision === 'withdrawn') findings.push({ rule: 'TR-2', message: `${where}: ${element.id} → ${ref}: атом отозван` });
    }
  }
  return findings;
}

/** Текст атома — от его якоря до следующего якоря внутри блока. */
export function atomTexts(blocks: Block[]): Map<string, { text: string; section: string }> {
  const texts = new Map<string, { text: string; section: string }>();
  for (const block of blocks) {
    const parts = block.text.split(/\{(R-\d{3,}|ctx)\}/);
    for (let i = 1; i < parts.length; i += 2) {
      const id = parts[i] ?? '';
      if (id !== 'ctx') texts.set(id, { text: (parts[i + 1] ?? '').trim(), section: block.section.title });
    }
  }
  return texts;
}

const TABLE_COLUMN = 'Таблица';
const FIELDS_COLUMN = 'Поля';
const TABLE_SECTION = /^[a-z_]+$/;

function backticked(text: string | undefined): string[] {
  return [...(text ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

/** Поле схемы — атом вида entity в разделе-таблице §9; узел графа покрывает его по имени поля (10.13). */
function nodeByField(section: string, text: string, elements: PdaElement[]): string | undefined {
  if (!TABLE_SECTION.test(section)) return undefined;
  const field = backticked(text)[0];
  if (field === undefined) return undefined;
  return elements.find(
    (element) =>
      element.id.startsWith('E-') &&
      backticked(element.cells[TABLE_COLUMN]).includes(section) &&
      backticked(element.cells[FIELDS_COLUMN]).includes(field),
  )?.id;
}

/** TR-4: покрытие атомов MVP элементами PDA нужного вида. Повторы, решения и атомы вида scope не считаются. */
export function coverage(
  registry: Registry,
  elements: PdaElement[],
  texts: Map<string, { text: string; section: string }> = new Map(),
): CoverageRow[] {
  const refsTo = new Map<string, string[]>();
  for (const element of elements) {
    for (const ref of element.refs) refsTo.set(ref, [...(refsTo.get(ref) ?? []), element.id]);
  }
  const rows: CoverageRow[] = [];
  for (const [id, atom] of registry.atoms) {
    if (atom.kind === 'scope' || atom.decision !== undefined || releaseOf(atom, registry) !== 'mvp') continue;
    const refs = [...(refsTo.get(id) ?? [])];
    const entry = texts.get(id);
    const node = atom.kind === 'entity' && entry ? nodeByField(entry.section, entry.text, elements) : undefined;
    if (node !== undefined && !refs.includes(node)) refs.push(node);
    const allowed = COVERED_BY[atom.kind];
    const status: Coverage =
      refs.length === 0 ? 'orphan' : refs.some((ref) => allowed.includes(ref.split('-')[0] ?? '')) ? 'covered' : 'partial';
    rows.push({ id, kind: atom.kind, status, refs });
  }
  return rows;
}

function section(lines: string[], title: string): { line: number; text: string }[] {
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).map((text, index) => ({ line: start + index + 2, text }));
}

/** Issue — markdown с front matter (`id`, `title`, `blocked_by`, `state`) и разделами «PDA» и «Атомы ТЗ». */
export function parseIssue(doc: PdaDoc): { issue?: Issue; findings: Finding[] } {
  const lines = doc.text.split(/\r?\n/);
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return { findings: [{ rule: 'TR-7', message: `${doc.file}: нет front matter` }] };
  let meta: unknown;
  try {
    meta = parseYaml(lines.slice(1, end).join('\n'));
  } catch (error) {
    return { findings: [{ rule: 'TR-7', message: `${doc.file}: front matter не разбирается: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }] };
  }
  if (!isRecord(meta) || typeof meta.id !== 'string' || !ISSUE_ID.test(meta.id) || typeof meta.title !== 'string') {
    return { findings: [{ rule: 'TR-7', message: `${doc.file}: в front matter нужны id вида I-01 и title` }] };
  }
  const atoms = section(lines, 'Атомы ТЗ').flatMap(({ line, text }) => {
    const match = ISSUE_ATOM.exec(text.trim());
    return match ? [{ id: match[2] ?? '', done: match[1] !== ' ', line }] : [];
  });
  const pda = section(lines, 'PDA')
    .map(({ text }) => text)
    .join('\n');
  const elements = [...new Set([...[...pda.matchAll(ISSUE_ELEMENT)].map((m) => m[0]), ...backticked(pda).map((name) => `EV-${name}`)])];
  const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
  const issue: Issue = {
    id: meta.id,
    file: doc.file,
    title: meta.title,
    labels: strings(meta.labels),
    closed: meta.state === 'closed',
    blockedBy: strings(meta.blocked_by),
    atoms,
    elements,
  };
  if (typeof meta.milestone === 'string') issue.milestone = meta.milestone;
  if (typeof meta.github === 'number') issue.github = meta.github;
  return { issue, findings: [] };
}

function cycleThrough(issues: Map<string, Issue>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    for (const next of issues.get(id)?.blockedBy ?? []) {
      const cycle = issues.has(next) ? walk(next, [...path, id]) : null;
      if (cycle) return cycle;
    }
    state.set(id, 'done');
    return null;
  };
  for (const id of issues.keys()) {
    const cycle = walk(id, []);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * TR-7: покрытый атом MVP назначен issue; у закрытой issue отмечены все атомы. TR-8: атомов в issue не больше MAX_ATOMS_PER_STEP.
 * TR-2: атомы, элементы PDA, blocked_by и каталог backlog указывают на существующее.
 */
export function checkBacklog(issues: Issue[], registry: Registry, elements: PdaElement[], rows: CoverageRow[], index?: string): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map<string, Issue>();
  const known = new Set(elements.map((e) => e.id));
  const assigned = new Set<string>();
  for (const issue of issues) {
    const first = byId.get(issue.id);
    if (first) findings.push({ rule: 'TR-2', message: `${issue.id} определена дважды: ${first.file} и ${issue.file}` });
    else byId.set(issue.id, issue);
    if (issue.atoms.length > MAX_ATOMS_PER_STEP) {
      findings.push({ rule: 'TR-8', message: `${issue.file}: ${issue.id} — атомов ${issue.atoms.length}, лимит ${MAX_ATOMS_PER_STEP}; режется по атомам, а не по слоям` });
    }
    const seen = new Set<string>();
    for (const { id, done, line } of issue.atoms) {
      const where = `${issue.file}:${line}`;
      const atom = registry.atoms.get(id);
      if (seen.has(id)) findings.push({ rule: 'TR-7', message: `${where}: ${id} дважды в ${issue.id}` });
      seen.add(id);
      assigned.add(id);
      if (!atom) findings.push({ rule: 'TR-2', message: `${where}: ${issue.id} → ${id}: такого атома нет` });
      else if (atom.decision === 'withdrawn') findings.push({ rule: 'TR-2', message: `${where}: ${issue.id} → ${id}: атом отозван` });
      else if (atom.kind === 'scope') findings.push({ rule: 'TR-7', message: `${where}: ${id} — пункт объёма работ, в issue не назначается` });
      else if (atom.decision !== undefined) findings.push({ rule: 'TR-7', message: `${where}: ${id} не к реализации — решение ${atom.decision}` });
      else if (releaseOf(atom, registry) !== 'mvp') findings.push({ rule: 'TR-7', message: `${where}: ${id} не входит в MVP` });
      if (issue.closed && !done) findings.push({ rule: 'TR-7', message: `${where}: ${issue.id} закрыта, а ${id} не отмечен` });
    }
    for (const element of issue.elements) {
      if (!known.has(element)) findings.push({ rule: 'TR-2', message: `${issue.file}: ${issue.id} → ${element.replace(/^EV-/, 'событие ')}: такого элемента PDA нет` });
    }
  }
  for (const issue of issues) {
    for (const ref of issue.blockedBy) {
      if (!byId.has(ref)) findings.push({ rule: 'TR-2', message: `${issue.file}: ${issue.id} blocked_by ${ref}: такой issue нет` });
    }
  }
  const cycle = cycleThrough(byId);
  if (cycle) findings.push({ rule: 'TR-2', message: `blocked_by по кругу: ${cycle.join(' → ')}` });
  for (const row of rows) {
    if (row.status === 'covered' && !assigned.has(row.id)) findings.push({ rule: 'TR-7', message: `${row.id} ${row.kind} покрыт в PDA, но не назначен ни одной issue` });
  }
  if (index !== undefined) {
    const listed = new Set([...index.matchAll(/\]\((I-\d{2,})\.md\)/g)].map((m) => m[1] ?? ''));
    for (const id of byId.keys()) if (!listed.has(id)) findings.push({ rule: 'TR-2', message: `${BACKLOG_DIR}/${BACKLOG_INDEX}: нет строки ${id}` });
    for (const id of listed) if (!byId.has(id)) findings.push({ rule: 'TR-2', message: `${BACKLOG_DIR}/${BACKLOG_INDEX}: ${id} — файла нет` });
  }
  return findings;
}

export function check(
  registryText: string,
  readSource: (path: string) => string,
  options: { gate: boolean; pda?: boolean },
  pdaDocs: PdaDoc[] = [],
  eventRegistryText?: string,
  backlog?: { issues: PdaDoc[]; index?: string },
): CheckResult {
  const { registry, findings } = parseRegistry(registryText);
  const markdown = registry.source ? readSource(registry.source) : '';
  const blocks = splitBlocks(markdown);
  const anchors = collectAnchors(markdown);
  const events = eventRegistryText === undefined ? { elements: [], findings: [] } : parseEventRegistry(eventRegistryText);
  const elements = [...pdaDocs.flatMap(parsePdaElements), ...events.elements];
  const tr1 = checkBlocks(blocks, options.gate);
  findings.push(
    ...tr1.findings,
    ...checkIds(anchors, registry),
    ...checkScope(registry),
    ...events.findings,
    ...checkPda(elements, registry),
    ...checkEventLinks(elements),
  );
  if (options.gate) findings.push(...checkGate(registry));
  const pda = options.pda ?? false;
  const rows = coverage(registry, elements, atomTexts(blocks));
  if (pda) {
    for (const row of rows) {
      if (row.status === 'covered') continue;
      const refs = row.refs.length > 0 ? `, есть только ${row.refs.join(', ')}` : '';
      findings.push({ rule: 'TR-4', message: `${row.id} ${row.status} · ${row.kind}: нужен элемент ${COVERED_BY[row.kind].join(' или ')}${refs}` });
    }
  }
  let issues: Issue[] | null = null;
  if (backlog !== undefined) {
    const parsed = backlog.issues.map(parseIssue);
    issues = parsed.flatMap((p) => (p.issue ? [p.issue] : []));
    findings.push(...parsed.flatMap((p) => p.findings), ...checkBacklog(issues, registry, elements, rows, backlog.index));
  }
  return { gate: options.gate, pda, source: registry.source, blocks, sections: tr1.sections, anchors, registry, elements, issues, findings };
}

function countBy<T>(items: Iterable<T>, key: (item: T) => string | undefined): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} ${n}`).join(' · ') || '—';
}

function coverageSummary(rows: CoverageRow[]): string {
  const byKind = new Map<Kind, { covered: number; total: number }>();
  for (const row of rows) {
    const entry = byKind.get(row.kind) ?? { covered: 0, total: 0 };
    entry.total += 1;
    if (row.status === 'covered') entry.covered += 1;
    byKind.set(row.kind, entry);
  }
  return [...byKind].map(([kind, { covered, total }]) => `${kind} ${covered}/${total}`).join(' · ') || '—';
}

export function formatUncovered(result: CheckResult, kind: string): string {
  const texts = atomTexts(result.blocks);
  const rows = coverage(result.registry, result.elements, texts).filter((row) => row.kind === kind && row.status !== 'covered');
  const lines = [`Не покрыты атомы MVP вида ${kind} (${rows.length}):`];
  for (const row of rows) {
    const entry = texts.get(row.id);
    const refs = row.refs.length > 0 ? ` [ссылки чужого вида: ${row.refs.join(', ')}]` : '';
    lines.push(`  ${row.id} ${row.status} · ${entry?.section ?? '?'} · ${entry?.text ?? ''}${refs}`);
  }
  return lines.join('\n');
}

export function formatReport(result: CheckResult): string {
  const { registry, sections, blocks, findings } = result;
  const atoms = [...registry.atoms.values()];
  const numbers = [...registry.atoms.keys()].map(idNumber).filter((n): n is number => n !== null);
  const anchored = blocks.filter((block) => ANCHOR_AT_START.test(block.text)).length;
  const started = sections.filter((s) => s.started);
  const pending = sections.filter((s) => !s.started);
  const rules: [Rule, string][] = [
    ['TR-1', `блоков ${blocks.length}, с якорем ${anchored}; размечено разделов ${started.length} из ${sections.length}`],
    ['TR-2', `атомов ${atoms.length}, следующий номер ${formatId(Math.max(0, ...numbers) + 1)}`],
    ['TR-3', `релизы scope: ${countBy(atoms, (a) => (a.kind === 'scope' ? a.release : undefined))}`],
    ['TR-5', `элементов PDA: ${countBy(result.elements, (e) => e.id.split('-')[0])}; ссылок на атомы: ${result.elements.reduce((n, e) => n + e.refs.length, 0)}`],
    ['TR-4', `покрыто атомов MVP по видам: ${coverageSummary(coverage(registry, result.elements, atomTexts(blocks)))}`],
    ['REG', `виды: ${countBy(atoms, (a) => a.kind)}; решения: ${countBy(atoms, (a) => a.decision)}`],
  ];
  if (result.issues !== null) {
    const covered = coverage(registry, result.elements, atomTexts(blocks)).filter((row) => row.status === 'covered');
    const assigned = new Set(result.issues.flatMap((issue) => issue.atoms.map((atom) => atom.id)));
    const closed = result.issues.filter((issue) => issue.closed).length;
    const largest = Math.max(0, ...result.issues.map((issue) => issue.atoms.length));
    rules.push(
      ['TR-7', `покрытых атомов MVP в issues: ${covered.filter((row) => assigned.has(row.id)).length}/${covered.length}; issues ${result.issues.length}, закрыто ${closed}`],
      ['TR-8', `атомов в issue: до ${largest} при лимите ${MAX_ATOMS_PER_STEP}`],
    );
  }
  if (result.gate) rules.push(['GATE', 'D-1…D-6 по 10.10']);

  const lines = [`tz:check · ${result.source || '?'} · ${result.gate ? 'gate' : 'шаг 0'}${result.pda ? ' · выход из PDA' : ''}`];
  for (const [rule, summary] of rules) {
    const own = findings.filter((f) => f.rule === rule);
    const status = own.length > 0 ? `✗ ${own.length}` : rule === 'TR-4' && !result.pda ? 'отчёт' : 'ok';
    lines.push(`${rule.padEnd(5)} ${status}  ${summary}`);
    for (const finding of own) lines.push(`      ${finding.message}`);
  }
  if (pending.length > 0 && !result.gate) {
    lines.push('', `Не размечены (${pending.length}): ${pending.map((s) => s.section.title || '(до заголовка)').join(' · ')}`);
  }
  const clarify = [...registry.atoms].filter(([, atom]) => atom.decision === 'clarify');
  if (clarify.length > 0) {
    lines.push('', `Открытые clarify (${clarify.length}):`);
    for (const [id, atom] of clarify) lines.push(`  ${[id, atom.defect].filter(Boolean).join(' ')} — ${atom.note ?? ''}`);
  }
  if (result.gate) {
    const referenced = new Set(atoms.map((a) => a.scope).filter((s): s is string => s !== undefined));
    const idle = [...registry.atoms]
      .filter(([id, a]) => a.kind === 'scope' && a.release === 'mvp' && a.decision === undefined && !referenced.has(id))
      .map(([id]) => id);
    if (idle.length > 0) lines.push('', `Пункты MVP, на которые не ссылается ни один атом (${idle.length}): ${idle.join(', ')}`);
  }
  return lines.join('\n');
}

const shown = (id: string): string => (id.startsWith('EV-') ? id.slice(3) : id);

/** tz:trace (10.8): атом → элементы PDA → issues → тесты. Трасса вычисляется, руками не ведётся. */
export function formatTrace(result: CheckResult, ids: string[], testsByInvariant: Map<string, string[]>): string {
  const texts = atomTexts(result.blocks);
  const rows = new Map(coverage(result.registry, result.elements, texts).map((row) => [row.id, row]));
  const lines: string[] = [];
  for (const id of ids) {
    const atom = result.registry.atoms.get(id);
    if (!atom) {
      lines.push(`${id}  такого атома нет`);
      continue;
    }
    const entry = texts.get(id);
    const row = rows.get(id);
    const refs = row?.refs ?? result.elements.filter((element) => element.refs.includes(id)).map((element) => element.id);
    const status = row?.status ?? atom.decision ?? (atom.kind === 'scope' ? `scope ${atom.release ?? ''}`.trim() : releaseOf(atom, result.registry) ?? '?');
    const issues = (result.issues ?? []).flatMap((issue) => {
      const item = issue.atoms.find((a) => a.id === id);
      return item ? [`${issue.id}${issue.github === undefined ? '' : ` #${issue.github}`}${item.done ? ' ✓' : ''}`] : [];
    });
    const tests = [...new Set(refs.filter((ref) => ref.startsWith('INV-')).flatMap((inv) => testsByInvariant.get(inv) ?? []))];
    lines.push(`${id}  §${entry?.section ?? '?'}  ${status}`, `  «${entry?.text ?? ''}»`);
    lines.push(`  → ${refs.map(shown).join(', ') || '—'}`, `  → ${issues.join(', ') || '—'}`, `  → ${tests.join(', ') || '—'}`);
  }
  return lines.join('\n');
}

function readDocs(dir: string, pattern: RegExp): PdaDoc[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      return { file, text: readFileSync(file, 'utf8') };
    });
}

function readBacklog(): { issues: PdaDoc[]; index?: string } | undefined {
  if (!existsSync(BACKLOG_DIR)) return undefined;
  const index = join(BACKLOG_DIR, BACKLOG_INDEX);
  const issues = readDocs(BACKLOG_DIR, /^I-\d{2,}.*\.md$/);
  return existsSync(index) ? { issues, index: readFileSync(index, 'utf8') } : { issues };
}

function testsByInvariant(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts')) for (const inv of testIds([readFileSync(path, 'utf8')])) map.set(inv, [...(map.get(inv) ?? []), path]);
    }
  };
  walk(TESTS_DIR);
  return map;
}

function main(argv: string[]): number {
  const result = check(
    readFileSync(REGISTRY_PATH, 'utf8'),
    (path) => readFileSync(path, 'utf8'),
    { gate: argv.includes('--gate'), pda: argv.includes('--pda') },
    readDocs(PDA_DIR, /\.md$/),
    existsSync(EVENT_REGISTRY_PATH) ? readFileSync(EVENT_REGISTRY_PATH, 'utf8') : undefined,
    readBacklog(),
  );
  if (argv.includes('--trace')) {
    const ids = argv.filter((arg) => /^R-\d{3,}$/.test(arg));
    console.log(formatTrace(result, ids, testsByInvariant()));
    return ids.every((id) => result.registry.atoms.has(id)) ? 0 : 1;
  }
  console.log(formatReport(result));
  const uncovered = argv.indexOf('--uncovered');
  if (uncovered >= 0) console.log(`\n${formatUncovered(result, argv[uncovered + 1] ?? '')}`);
  return result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
