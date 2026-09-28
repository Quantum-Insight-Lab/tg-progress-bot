import { describe, expect, it } from 'vitest';
import { generate, typeOf, zodOf } from '../scripts/codegen-events.ts';

describe('S-3: генерация типов событий из реестра', () => {
  it('типы полей: примитивы, enum, null, массивы, список объектов', () => {
    expect(typeOf('string')).toBe('string');
    expect(typeOf('int | null')).toBe('number | null');
    expect(typeOf('enum[high, normal, low]')).toBe("'high' | 'normal' | 'low'");
    expect(typeOf('enum[completed, not_planned] | null')).toBe("'completed' | 'not_planned' | null");
    expect(typeOf('string[]')).toBe('string[]');
    expect(typeOf([{ sha: 'string' }])).toBe('{\n  sha: string;\n}[]');
    expect(() => typeOf('money')).toThrow('неизвестный тип поля: money');
  });

  it('константы, версии, конверт и payload по типу события', () => {
    const text = generate(['envelope:', '  event_id: uuid', 'events:', '  - type: task.created', '    version: 2', '    payload:', '      task_id: string', ''].join('\n'));
    expect(text).toContain("TASK_CREATED: 'task.created',");
    expect(text).toContain("'task.created': 2,");
    expect(text).toContain('export interface EventEnvelope {\n  event_id: string;\n}');
    expect(text).toContain('export interface TaskCreatedPayload {\n  task_id: string;\n}');
    expect(text).toContain("'task.created': TaskCreatedPayload;");
  });

  it('схема Zod повторяет поле реестра', () => {
    expect(zodOf('enum[high, normal, low]')).toBe("z.enum(['high', 'normal', 'low'])");
    expect(zodOf('int | null')).toBe('z.union([z.number().int(), z.null()])');
    expect(zodOf('string[]')).toBe('z.array(z.string())');
    expect(zodOf([{ sha: 'string' }])).toBe('z.array(z.strictObject({\n  sha: z.string(),\n}))');
    expect(zodOf('enum[completed, not_planned] | null')).toBe("z.union([z.enum(['completed', 'not_planned']), z.null()])");
    expect(() => zodOf('money')).toThrow('неизвестный тип поля: money');
  });

  it('генерация включает схемы рядом с типами', () => {
    const text = generate(['envelope:', '  event_id: uuid', 'events:', '  - type: task.created', '    version: 2', '    payload:', '      task_id: string', ''].join('\n'));
    expect(text).toContain("import { z } from 'zod';");
    expect(text).toContain('export const EventEnvelopeSchema = z.strictObject({\n  event_id: z.uuid(),\n});');
    expect(text).toContain('export const TaskCreatedPayloadSchema = z.strictObject({\n  task_id: z.string(),\n});');
    expect(text).toContain("'task.created': TaskCreatedPayloadSchema,");
  });

  it('событие без payload не проходит молча', () => {
    expect(() => generate('envelope: {}\nevents:\n  - type: x.y\n    version: 1\n')).toThrow('событие №1 без type, version или payload');
  });
});
