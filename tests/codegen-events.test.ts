import { describe, expect, it } from 'vitest';
import { generate, typeOf } from '../scripts/codegen-events.ts';

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

  it('событие без payload не проходит молча', () => {
    expect(() => generate('envelope: {}\nevents:\n  - type: x.y\n    version: 1\n')).toThrow('событие №1 без type, version или payload');
  });
});
