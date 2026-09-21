export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

export function occurredIso(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}
