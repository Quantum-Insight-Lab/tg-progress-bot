import { describe, expect, it } from 'vitest';
import { tasksPart } from '../src/domain/tasks/index.ts';
import { eventProcessorPart } from '../src/events/processor.ts';
import { githubMirrorPart } from '../src/github/mirror.ts';
import { createProgressEngine } from '../src/progress-engine.ts';
import { reportGeneratorPart } from '../src/projections/report-generator.ts';

describe('Progress Engine', () => {
  it('собирает Tasks, GitHub mirror, Event Processor и Report Generator в одном объекте', () => {
    const engine = createProgressEngine();
    expect(engine.tasks).toBe(tasksPart);
    expect(engine.githubMirror).toBe(githubMirrorPart);
    expect(engine.githubMirror.scope).toBe('repository');
    expect(engine.eventProcessor).toBe(eventProcessorPart);
    expect(engine.reportGenerator).toBe(reportGeneratorPart);
    expect(createProgressEngine()).toEqual(engine);
  });
});
