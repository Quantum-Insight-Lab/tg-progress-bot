/**
 * S-3: типы событий генерируются из реестра, ручного объявления типа события нет.
 *   npm run codegen:events             — перегенерировать src/events/generated/events.ts
 *   npm run codegen:events -- --check  — упасть, если закоммиченный файл разошёлся с реестром
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const EVENT_REGISTRY_PATH = 'contracts/event-registry.yaml';
export const GENERATED_PATH = 'src/events/generated/events.ts';

const PRIMITIVES: Readonly<Record<string, string>> = {
  string: 'string',
  int: 'number',
  number: 'number',
  bool: 'boolean',
  date: 'string',
  time: 'string',
  timestamp: 'string',
  uuid: 'string',
  object: 'Record<string, unknown>',
  null: 'null',
};

const HEADER = '// Сгенерировано из contracts/event-registry.yaml командой npm run codegen:events. Руками не править (S-3).\n';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(spec: string): string {
  const values = /^enum\[(.+)\]$/.exec(spec)?.[1];
  if (values !== undefined) {
    return values
      .split(',')
      .map((value) => `'${value.trim()}'`)
      .join(' | ');
  }
  const item = /^(.+)\[\]$/.exec(spec)?.[1];
  if (item !== undefined) return `${scalar(item)}[]`;
  const primitive = PRIMITIVES[spec];
  if (primitive === undefined) throw new Error(`неизвестный тип поля: ${spec}`);
  return primitive;
}

/** Тип поля реестра: примитив, `enum[a, b]`, `T[]`, `A | null`; вложенный объект; список из одного объекта — массив объектов. */
export function typeOf(spec: unknown, indent = 0): string {
  if (Array.isArray(spec)) {
    if (spec.length !== 1) throw new Error('список в схеме описывает ровно один элемент');
    return `${typeOf(spec[0], indent)}[]`;
  }
  if (isRecord(spec)) {
    const pad = '  '.repeat(indent + 1);
    const fields = Object.entries(spec).map(([key, value]) => `${pad}${key}: ${typeOf(value, indent + 1)};`);
    return `{\n${fields.join('\n')}\n${'  '.repeat(indent)}}`;
  }
  if (typeof spec !== 'string') throw new Error(`неизвестный тип поля: ${JSON.stringify(spec)}`);
  return spec
    .split('|')
    .map((part) => scalar(part.trim()))
    .join(' | ');
}

const constName = (type: string): string => type.replace(/[.]/g, '_').toUpperCase();
const pascal = (type: string): string =>
  type
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/** Текст src/events/generated/events.ts по тексту реестра. */
export function generate(registryText: string): string {
  const root: unknown = parseYaml(registryText);
  if (!isRecord(root) || !isRecord(root.envelope) || !Array.isArray(root.events) || root.events.length === 0) {
    throw new Error(`${EVENT_REGISTRY_PATH}: нужны envelope и непустой events`);
  }
  const events = root.events.map((event, index) => {
    if (!isRecord(event) || typeof event.type !== 'string' || typeof event.version !== 'number' || !isRecord(event.payload)) {
      throw new Error(`${EVENT_REGISTRY_PATH}: событие №${index + 1} без type, version или payload`);
    }
    return { type: event.type, version: event.version, payload: event.payload };
  });
  return [
    HEADER,
    'export const EVENT_TYPES = {',
    ...events.map((e) => `  ${constName(e.type)}: '${e.type}',`),
    '} as const;',
    '',
    'export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];',
    '',
    'export const EVENT_VERSIONS = {',
    ...events.map((e) => `  '${e.type}': ${e.version},`),
    '} as const satisfies Record<EventType, number>;',
    '',
    `export interface EventEnvelope ${typeOf(root.envelope)}`,
    ...events.flatMap((e) => ['', `export interface ${pascal(e.type)}Payload ${typeOf(e.payload)}`]),
    '',
    'export interface PayloadByType {',
    ...events.map((e) => `  '${e.type}': ${pascal(e.type)}Payload;`),
    '}',
    '',
  ].join('\n');
}

function main(argv: string[]): number {
  const expected = generate(readFileSync(EVENT_REGISTRY_PATH, 'utf8'));
  if (argv.includes('--check')) {
    const actual = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : '';
    if (actual === expected) return 0;
    console.error(`S-3: ${GENERATED_PATH} расходится с ${EVENT_REGISTRY_PATH}. Запустите npm run codegen:events и закоммитьте результат.`);
    return 1;
  }
  mkdirSync(dirname(GENERATED_PATH), { recursive: true });
  writeFileSync(GENERATED_PATH, expected);
  console.log(`${GENERATED_PATH}: обновлён`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
