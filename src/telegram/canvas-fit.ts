import {
  CANVAS_FIT_BLOCKERS,
  CANVAS_FIT_DYNAMICS,
  CANVAS_FIT_KEEP,
  CANVAS_FIT_SLICE,
  CANVAS_FIT_TASKS,
  fitCanvas,
  type CanvasFitKind,
} from '../domain/tasks/fit-canvas.ts';
import {
  CANVAS_SECTION_ORDER,
  canvasHeaderLine,
  canvasParagraphChars,
  renderCanvasMessage,
  type CanvasBodySection,
  type CanvasParagraph,
  type CanvasRichMessage,
  type CanvasSectionId,
} from '../projections/canvas-message.ts';

const SECTION_KIND: Record<CanvasSectionId, CanvasFitKind> = {
  header: CANVAS_FIT_KEEP,
  backlog: CANVAS_FIT_KEEP,
  person: CANVAS_FIT_KEEP,
  done: CANVAS_FIT_SLICE,
  inProgress: CANVAS_FIT_SLICE,
  next: CANVAS_FIT_SLICE,
  tasks: CANVAS_FIT_TASKS,
  plan: CANVAS_FIT_KEEP,
  blockers: CANVAS_FIT_BLOCKERS,
  github: CANVAS_FIT_KEEP,
  divergence: CANVAS_FIT_KEEP,
  dynamics: CANVAS_FIT_DYNAMICS,
};

export type PreparedCanvas =
  | { status: 'ready'; message: CanvasRichMessage; shrunk: boolean }
  | { status: 'full' };

/**
 * Собрать канвас в лимит rich message.
 * Срезы, блокеры и динамика ужимаются. Задачи остаются. Иначе отказ.
 */
export function prepareCanvasMessage(input: {
  projectName: string;
  canvasDate: string;
  sections?: Partial<Record<CanvasBodySection, readonly CanvasParagraph[]>>;
}): PreparedCanvas {
  const rows: { paragraph: CanvasParagraph; kind: CanvasFitKind }[] = [
    {
      paragraph: { pieces: [{ kind: 'text', text: canvasHeaderLine(input.projectName, input.canvasDate) }] },
      kind: CANVAS_FIT_KEEP,
    },
  ];
  for (const id of CANVAS_SECTION_ORDER) {
    if (id === 'header') continue;
    const block = input.sections?.[id];
    if (block === undefined || block.length === 0) continue;
    for (const paragraph of block) rows.push({ paragraph, kind: SECTION_KIND[id] });
  }
  const fit = fitCanvas(
    rows.map((row) => ({
      kind: row.kind,
      chars: canvasParagraphChars(row.paragraph),
      blocks: 1,
    })),
  );
  if (fit.status === 'full') return { status: 'full' };
  const paragraphs: CanvasParagraph[] = [];
  for (const index of fit.kept) {
    const row = rows[index];
    if (row !== undefined) paragraphs.push(row.paragraph);
  }
  return { status: 'ready', shrunk: fit.shrunk, message: renderCanvasMessage(paragraphs) };
}
