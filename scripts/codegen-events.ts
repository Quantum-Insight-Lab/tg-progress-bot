/**
 * S-3: типы и Zod-схемы только из contracts/event-registry.yaml.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = join(root, "contracts/event-registry.yaml");
const outDir = join(root, "src/events/generated");

const HEADER = `/**
 * Generated from contracts/event-registry.yaml. Do not edit.
 * Source: npm run codegen:events
 */
`;

const PRIMITIVE_TS: Record<string, string> = {
  string: "string",
  int: "number",
  float: "number",
  boolean: "boolean",
  timestamp: "string",
  uuid: "string",
  object: "Record<string, unknown>",
};

const PRIMITIVE_ZOD: Record<string, string> = {
  string: "z.string()",
  int: "z.number().int()",
  float: "z.number()",
  boolean: "z.boolean()",
  timestamp: "z.string()",
  uuid: "z.string()",
  object: "z.record(z.string(), z.unknown())",
};

type RegistryEvent = {
  type: string;
  version: number;
  context: string;
  payload: Record<string, unknown>;
};

type Registry = {
  envelope: Record<string, unknown>;
  events: RegistryEvent[];
};

function toConstName(eventType: string): string {
  return eventType
    .split(".")
    .map((part) => part.split("_").map((s) => s.toUpperCase()).join("_"))
    .join("_");
}

function toPascal(eventType: string): string {
  return eventType
    .split(/[._]/)
    .map((s) => s.slice(0, 1).toUpperCase() + s.slice(1))
    .join("");
}

function splitNullable(spec: string): { core: string; nullable: boolean } {
  if (spec.endsWith(" | null")) {
    return { core: spec.slice(0, -" | null".length), nullable: true };
  }
  return { core: spec, nullable: false };
}

function yamlScalarToTs(spec: string): string {
  const { core, nullable } = splitNullable(spec);
  const enumMatch = /^enum\[(.+)\]$/.exec(core);
  const arrayMatch = /^array\[(.+)\]$/.exec(core);
  let ts: string;
  if (enumMatch?.[1] !== undefined) {
    ts = enumMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => JSON.stringify(s))
      .join(" | ");
  } else if (arrayMatch?.[1] !== undefined) {
    ts = `${yamlScalarToTs(arrayMatch[1])}[]`;
  } else {
    const mapped = PRIMITIVE_TS[core];
    if (mapped === undefined) {
      throw new Error(`Unknown YAML type: ${core}`);
    }
    ts = mapped;
  }
  return nullable ? `${ts} | null` : ts;
}

function yamlScalarToZod(spec: string): string {
  const { core, nullable } = splitNullable(spec);
  const enumMatch = /^enum\[(.+)\]$/.exec(core);
  const arrayMatch = /^array\[(.+)\]$/.exec(core);
  let expr: string;
  if (enumMatch?.[1] !== undefined) {
    const values = enumMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => JSON.stringify(s));
    expr = `z.enum([${values.join(", ")}])`;
  } else if (arrayMatch?.[1] !== undefined) {
    expr = `z.array(${yamlScalarToZod(arrayMatch[1])})`;
  } else {
    const mapped = PRIMITIVE_ZOD[core];
    if (mapped === undefined) {
      throw new Error(`Unknown YAML type: ${core}`);
    }
    expr = mapped;
  }
  return nullable ? `${expr}.nullable()` : expr;
}

function toTsType(spec: unknown, indent = 0): string {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    const fieldPad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const fields = Object.entries(spec as Record<string, unknown>)
      .map(([key, value]) => `${fieldPad}${key}: ${toTsType(value, indent + 1)};`)
      .join("\n");
    return `{\n${fields}\n${closePad}}`;
  }
  if (typeof spec !== "string") {
    throw new Error(`Unsupported type spec: ${JSON.stringify(spec)}`);
  }
  return yamlScalarToTs(spec);
}

function toZodExpr(spec: unknown): string {
  if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
    const fields = Object.entries(spec as Record<string, unknown>)
      .map(([key, value]) => `  ${key}: ${toZodExpr(value)},`)
      .join("\n");
    return `z.object({\n${fields}\n})`;
  }
  if (typeof spec !== "string") {
    throw new Error(`Unsupported type spec: ${JSON.stringify(spec)}`);
  }
  return yamlScalarToZod(spec);
}

export function generateEventTypes(): void {
  const registry = parse(readFileSync(registryPath, "utf8")) as Registry;
  if (!Array.isArray(registry.events) || registry.events.length === 0) {
    throw new Error("event-registry.yaml: events[] пуст");
  }

  const constEntries = registry.events
    .map((event) => `  ${toConstName(event.type)}: ${JSON.stringify(event.type)},`)
    .join("\n");

  const eventTypes = `${HEADER}
export const EVENT_TYPES = {
${constEntries}
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const EVENT_TYPE_VALUES: readonly EventType[] = Object.values(EVENT_TYPES);

export const EVENT_SCHEMA_VERSIONS = {
${registry.events.map((event) => `  ${JSON.stringify(event.type)}: ${String(event.version)},`).join("\n")}
} as const satisfies Record<EventType, number>;
`;

  const envelopeFields = Object.entries(registry.envelope)
    .map(([key, value]) => `  ${key}: ${toTsType(value, 1)};`)
    .join("\n");

  const payloadTypes = registry.events
    .map((event) => {
      const name = `${toPascal(event.type)}Payload`;
      return `export type ${name} = ${toTsType(event.payload)};`;
    })
    .join("\n\n");

  const payloads = `${HEADER}
export type EventEnvelope = {
${envelopeFields}
};

${payloadTypes}

export type PayloadByType = {
${registry.events.map((event) => `  ${JSON.stringify(event.type)}: ${toPascal(event.type)}Payload;`).join("\n")}
};
`;

  const schemaConsts = registry.events
    .map((event) => {
      const pascal = toPascal(event.type);
      const schemaName = `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}PayloadSchema`;
      return `export const ${schemaName} = ${toZodExpr(event.payload)};`;
    })
    .join("\n\n");

  const schemaMap = registry.events
    .map((event) => {
      const pascal = toPascal(event.type);
      const schemaName = `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}PayloadSchema`;
      return `  [EVENT_TYPES.${toConstName(event.type)}]: ${schemaName},`;
    })
    .join("\n");

  const schemas = `${HEADER}
import { z } from "zod";
import { EVENT_TYPES } from "./event-types.js";

${schemaConsts}

export const payloadSchemas = {
${schemaMap}
} as const;
`;

  const index = `${HEADER}
export * from "./event-types.js";
export * from "./payloads.js";
export * from "./schemas.js";
`;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "event-types.ts"), eventTypes);
  writeFileSync(join(outDir, "payloads.ts"), payloads);
  writeFileSync(join(outDir, "schemas.ts"), schemas);
  writeFileSync(join(outDir, "index.ts"), index);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  generateEventTypes();
}
