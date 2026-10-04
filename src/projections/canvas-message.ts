/**
 * P-1. Канвас целиком: одно rich message, блоки сверху вниз.
 * P-2. Шапка: имя проекта и дата суток проекта.
 * Поздние проекции заполняют свои блоки. Пустой блок строку не занимает.
 * Действие задачи — кнопка внутри абзаца, стиль ссылки. Ряда кнопок нет.
 */

/** Стиль кнопки действия. В Bot API `link` разрешён только callback-кнопке. */
export const CANVAS_LINK_STYLE = 'link' as const;

export type CanvasPiece =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'action'; label: string; callbackData: string };

export interface CanvasParagraph {
  pieces: readonly CanvasPiece[];
  /** Строка человека и срезы issues: один раскрывающийся блок. */
  fold?: boolean;
}

/** Жирный заголовок блока. Размер строки не меняется. */
export function canvasHeading(text: string): CanvasParagraph {
  return { pieces: [{ kind: 'bold', text }] };
}

export interface CanvasLinkButton {
  text: string;
  style: typeof CANVAS_LINK_STYLE;
  callback_data: string;
}

export interface CanvasTextButton {
  type: 'button';
  button: CanvasLinkButton;
}

export interface CanvasBoldText {
  type: 'bold';
  text: string;
}

export type CanvasRichText = string | CanvasTextButton | CanvasBoldText | CanvasRichText[];

export interface CanvasParagraphBlock {
  type: 'paragraph';
  text: CanvasRichText;
}

export interface CanvasExpandableBlock {
  type: 'expandable_blockquote';
  text: CanvasRichText;
}

export type CanvasBlock = CanvasParagraphBlock | CanvasExpandableBlock;

export interface CanvasRichMessage {
  blocks: CanvasBlock[];
}

/** Галочка `- [ ]` в rich message — рисунок: у неё нет `callback_data`. */
export const CANVAS_CHECKBOX_OPEN = '- [ ]';

/** Отмеченный рисунок. Нажатие боту тоже не приходит. */
export const CANVAS_CHECKBOX_DONE = '- [x]';

/** Видимый текст абзаца: обычный текст и подписи кнопок. */
export function canvasParagraphChars(paragraph: CanvasParagraph): number {
  let chars = 0;
  for (const piece of paragraph.pieces) {
    if (piece.kind === 'action') chars += piece.label.length;
    else chars += piece.text.length;
  }
  return chars;
}

function assertCheckboxDrawing(paragraph: CanvasParagraph): void {
  for (const piece of paragraph.pieces) {
    if (piece.kind !== 'action') continue;
    if (piece.label === CANVAS_CHECKBOX_OPEN || piece.label === CANVAS_CHECKBOX_DONE) {
      throw new Error('галочка - [ ] в rich message — рисунок без callback_data');
    }
  }
}

function linkButton(label: string, callbackData: string): CanvasTextButton {
  return {
    type: 'button',
    button: {
      text: label,
      style: CANVAS_LINK_STYLE,
      callback_data: callbackData,
    },
  };
}

function paragraphText(pieces: readonly CanvasPiece[]): CanvasRichText {
  const nodes: Array<string | CanvasTextButton | CanvasBoldText> = [];
  let plain = '';
  let hasAction = false;
  const flush = (): void => {
    if (plain.length === 0) return;
    nodes.push(plain);
    plain = '';
  };
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      plain += piece.text;
      continue;
    }
    if (piece.kind === 'bold') {
      hasAction = true;
      flush();
      nodes.push({ type: 'bold', text: piece.text });
      continue;
    }
    hasAction = true;
    flush();
    nodes.push(linkButton(piece.label, piece.callbackData));
  }
  if (!hasAction) return plain;
  flush();
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only !== undefined) return only;
  }
  return nodes;
}

/**
 * Состав сверху вниз. Шапка первая.
 * Расхождение стоит сразу под строкой GitHub, динамика — следом.
 */
export const CANVAS_SECTION_ORDER = [
  'header',
  'backlog',
  'tasks',
  'plan',
  'blockers',
  'person',
  'inProgress',
  'next',
  'done',
  'github',
  'divergence',
  'dynamics',
] as const;

const FOLDED_SECTIONS = new Set<CanvasBodySection>(['person', 'inProgress', 'next', 'done']);

export type CanvasSectionId = (typeof CANVAS_SECTION_ORDER)[number];

export type CanvasBodySection = Exclude<CanvasSectionId, 'header'>;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Шапка: «ПРОЕКТ: имя · ДД.ММ». Дата — уже посчитанные сутки проекта. */
export function canvasHeaderLine(projectName: string, canvasDate: string): string {
  const name = projectName.trim();
  if (name.length === 0) throw new Error('у шапки канваса есть имя проекта');
  const match = CALENDAR_DATE.exec(canvasDate.trim());
  const day = match?.[3];
  const month = match?.[2];
  if (day === undefined || month === undefined) throw new Error('дата шапки — календарный день проекта');
  return `ПРОЕКТ: ${name} · ${day}.${month}`;
}

/**
 * Канвас на сутки: шапка и переданные блоки в порядке состава.
 * Блок без абзацев не печатается. Меню задач здесь нет.
 */
export function renderCanvas(input: {
  projectName: string;
  canvasDate: string;
  sections?: Partial<Record<CanvasBodySection, readonly CanvasParagraph[]>>;
}): CanvasRichMessage {
  const paragraphs: CanvasParagraph[] = [
    { pieces: [{ kind: 'bold', text: canvasHeaderLine(input.projectName, input.canvasDate) }] },
  ];
  for (const id of CANVAS_SECTION_ORDER) {
    if (id === 'header') continue;
    const block = input.sections?.[id];
    if (block === undefined || block.length === 0) continue;
    paragraphs.push(...placeSection(id, block));
  }
  return renderCanvasMessage(paragraphs);
}

function placeSection(id: CanvasBodySection, block: readonly CanvasParagraph[]): CanvasParagraph[] {
  if (!FOLDED_SECTIONS.has(id)) return [...block];
  return block.map((paragraph) => ({ ...paragraph, fold: true }));
}

function joinFold(paragraphs: readonly CanvasParagraph[]): CanvasRichText {
  const nodes: Array<string | CanvasTextButton | CanvasBoldText> = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) nodes.push('\n');
    const text = paragraphText(paragraph.pieces);
    if (typeof text === 'string') nodes.push(text);
    else if (Array.isArray(text)) {
      for (const part of text) {
        if (typeof part === 'string' || !Array.isArray(part)) nodes.push(part);
      }
    } else nodes.push(text);
  });
  if (nodes.length === 1) {
    const only = nodes[0];
    if (only !== undefined) return only;
  }
  return nodes;
}

/** Абзацы канваса. Кнопка действия лежит в тексте абзаца, отдельным блоком кнопок не выносится. */
export function renderCanvasMessage(paragraphs: readonly CanvasParagraph[]): CanvasRichMessage {
  for (const paragraph of paragraphs) assertCheckboxDrawing(paragraph);
  const blocks: CanvasBlock[] = [];
  let fold: CanvasParagraph[] = [];
  const flushFold = (): void => {
    if (fold.length === 0) return;
    blocks.push({ type: 'expandable_blockquote', text: joinFold(fold) });
    fold = [];
  };
  for (const paragraph of paragraphs) {
    if (paragraph.fold === true) {
      fold.push(paragraph);
      continue;
    }
    flushFold();
    blocks.push({ type: 'paragraph', text: paragraphText(paragraph.pieces) });
  }
  flushFold();
  return { blocks };
}
