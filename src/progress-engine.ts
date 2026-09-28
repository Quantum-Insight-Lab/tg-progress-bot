import { tasksPart } from './domain/tasks/index.ts';
import { eventProcessorPart } from './events/processor.ts';
import { githubMirrorPart } from './github/mirror.ts';
import { reportGeneratorPart } from './projections/report-generator.ts';

export interface ProgressEngine {
  readonly tasks: typeof tasksPart;
  readonly githubMirror: typeof githubMirrorPart;
  readonly eventProcessor: typeof eventProcessorPart;
  readonly reportGenerator: typeof reportGeneratorPart;
}

/** Один Progress Engine: части — границы модулей, не отдельные процессы (B-3). */
export function createProgressEngine(): ProgressEngine {
  return {
    tasks: tasksPart,
    githubMirror: githubMirrorPart,
    eventProcessor: eventProcessorPart,
    reportGenerator: reportGeneratorPart,
  };
}
