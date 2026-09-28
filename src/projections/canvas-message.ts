/**
 * P-1. Форма канваса: одно rich message из абзацев.
 * Действие задачи — кнопка внутри абзаца, стиль ссылки. Ряда кнопок нет.
 */

/** Стиль кнопки действия. В Bot API `link` разрешён только callback-кнопке. */
export const CANVAS_LINK_STYLE = 'link' as const;

export type CanvasPiece =
  | { kind: 'text'; text: string }
  | { kind: 'action'; label: string; callbackData: string };

export interface CanvasParagraph {
  pieces: readonly CanvasPiece[];
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

export type CanvasRichText = string | CanvasTextButton | CanvasRichText[];

export interface CanvasParagraphBlock {
  type: 'paragraph';
  text: CanvasRichText;
}

export interface CanvasRichMessage {
  blocks: CanvasParagraphBlock[];
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
  const nodes: Array<string | CanvasTextButton> = [];
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
    hasAction = true;
    flush();
    nodes.push(linkButton(piece.label, piece.callbackData));
  }
  if (!hasAction) return plain;
  flush();
  return nodes;
}

/**
 * Оболочка одного сообщения на день.
 * Состав блоков сверху вниз приходит отдельными issues. Меню задач и кнопок здесь нет.
 */
export function renderCanvasShell(): CanvasRichMessage {
  return renderCanvasMessage([{ pieces: [{ kind: 'text', text: ' ' }] }]);
}

/** Абзацы канваса. Кнопка действия лежит в тексте абзаца, отдельным блоком кнопок не выносится. */
export function renderCanvasMessage(paragraphs: readonly CanvasParagraph[]): CanvasRichMessage {
  return {
    blocks: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      text: paragraphText(paragraph.pieces),
    })),
  };
}
