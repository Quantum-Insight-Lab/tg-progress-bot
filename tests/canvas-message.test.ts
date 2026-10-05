import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transformer } from 'grammy';
import {
  CANVAS_CHECKBOX_DONE,
  CANVAS_CHECKBOX_OPEN,
  CANVAS_LINK_STYLE,
  CANVAS_SECTION_ORDER,
  renderCanvas,
  renderCanvasMessage,
  type CanvasParagraph,
  type CanvasRichMessage,
  type CanvasRichText,
  type CanvasTextButton,
} from '../src/projections/canvas-message.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { editCanvasMessage, sendCanvasMessage } from '../src/telegram/canvas-message.ts';
import { testBotInfo } from './bot-info.ts';

const taskParagraph = renderCanvasMessage([
  {
    pieces: [
      { kind: 'text', text: 'строка задачи ' },
      { kind: 'action', label: 'действие', callbackData: 'task:1' },
      { kind: 'text', text: ' ' },
      { kind: 'action', label: 'ещё', callbackData: 'task:2' },
    ],
  },
]);

function isButton(part: CanvasRichText): part is CanvasTextButton {
  return typeof part !== 'string' && !Array.isArray(part) && part.type === 'button';
}

function buttonsOf(message: CanvasRichMessage): CanvasTextButton[] {
  const found: CanvasTextButton[] = [];
  const walk = (text: CanvasRichText): void => {
    if (typeof text === 'string') return;
    if (Array.isArray(text)) {
      for (const part of text) walk(part);
      return;
    }
    if (text.type === 'bold') return;
    found.push(text);
  };
  for (const block of message.blocks) walk(block.text);
  return found;
}

describe('P-1 канвас — rich message', () => {
  it('R-596 действия — кнопки внутри абзаца задачи, RichTextButton и callback_data', () => {
    expect(taskParagraph.blocks).toHaveLength(1);
    const block = taskParagraph.blocks[0];
    expect(block?.type).toBe('paragraph');
    expect(Array.isArray(block?.text)).toBe(true);
    if (!Array.isArray(block?.text)) throw new Error('абзац без частей');
    const buttons = block.text.filter(isButton);
    expect(buttons.map((button) => button.type)).toEqual(['button', 'button']);
    expect(buttons.map((button) => button.button.callback_data)).toEqual(['task:1', 'task:2']);
    expect(block.text.some((part) => part === 'строка задачи ')).toBe(true);
  });

  it('R-597 стиль link', () => {
    const buttons = buttonsOf(taskParagraph);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.button.style === CANVAS_LINK_STYLE)).toBe(true);
    expect(buttons.every((button) => button.button.style === 'link')).toBe(true);
  });

  it('R-599 ряда кнопок tg-button-row нет', () => {
    expect(taskParagraph.blocks.map((block) => block.type)).toEqual(['paragraph']);
    expect(JSON.stringify(taskParagraph)).not.toContain('tg-button-row');
    expect(JSON.stringify(taskParagraph)).not.toContain('"type":"buttons"');
  });
});

interface Captured {
  method: string;
  payload: unknown;
}

function capture(calls: Captured[]): Transformer {
  return (async (_prev, method, payload) => {
    calls.push({ method, payload });
    return {
      ok: true,
      result: {
        message_id: 9,
        date: 1,
        chat: { id: 1, type: 'supergroup' },
        rich_message: { blocks: [] },
      },
    };
  }) as Transformer;
}

function fieldsOf(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) throw new Error('payload');
  return payload as Record<string, unknown>;
}

describe('B-6 канвас уходит в топик', () => {
  const calls: Captured[] = [];
  let bot: ReturnType<typeof createTelegramBot>;

  beforeAll(() => {
    bot = createTelegramBot('test-token', testBotInfo);
    bot.api.config.use(capture(calls));
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('R-594 канвас — rich message sendRichMessage', async () => {
    const messageId = await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, taskParagraph);
    expect(messageId).toBe(9);
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage']);
    expect(fieldsOf(calls[0]?.payload).rich_message).toEqual(taskParagraph);
  });

  it('R-616 в топик сообщение уходит с message_thread_id', async () => {
    await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, taskParagraph);
    const payload = fieldsOf(calls[0]?.payload);
    expect(payload.chat_id).toBe('-1001');
    expect(payload.message_thread_id).toBe(42);
  });

  it('INV-23 оболочка канваса без меню задач и без кнопок', () => {
    const shell = renderCanvas({ projectName: 'Альфа', canvasDate: '2026-09-28' });
    expect(shell.blocks).toHaveLength(1);
    expect(buttonsOf(shell)).toEqual([]);
    expect(JSON.stringify(shell)).not.toContain('reply_markup');
    expect(JSON.stringify(shell)).not.toContain('inline_keyboard');
    expect(JSON.stringify(shell)).not.toContain('"type":"button"');
    expect(JSON.stringify(shell)).not.toContain('в план');
    expect(JSON.stringify(shell)).not.toContain('подтвердить');
  });

  it('INV-23 правка того же сообщения, без клавиатуры и без второго send', async () => {
    await editCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, 9, taskParagraph);
    expect(calls.map((call) => call.method)).toEqual(['editMessageText']);
    const payload = fieldsOf(calls[0]?.payload);
    expect(payload.chat_id).toBe('-1001');
    expect(payload.message_id).toBe(9);
    expect(payload.rich_message).toEqual(taskParagraph);
    expect(payload).not.toHaveProperty('reply_markup');
    expect(payload).not.toHaveProperty('text');
    expect(JSON.stringify(payload)).not.toContain('inline_keyboard');
  });

  it('R-608 галочка - [ ] в rich message — рисунок без callback_data', () => {
    const drawn = renderCanvasMessage([{ pieces: [{ kind: 'text', text: `${CANVAS_CHECKBOX_OPEN} пункт` }] }]);
    expect(JSON.stringify(drawn)).toContain(CANVAS_CHECKBOX_OPEN);
    expect(JSON.stringify(drawn)).not.toContain('callback_data');
    expect(() =>
      renderCanvasMessage([
        { pieces: [{ kind: 'action', label: CANVAS_CHECKBOX_OPEN, callbackData: 'task:mark:1' }] },
      ]),
    ).toThrow(/рисунок/);
    expect(() =>
      renderCanvasMessage([{ pieces: [{ kind: 'action', label: CANVAS_CHECKBOX_DONE, callbackData: 'task:mark:1' }] }]),
    ).toThrow(/рисунок/);
  });

  it('R-610 sendChecklist не используем', async () => {
    await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, taskParagraph);
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage']);
    expect(calls.some((call) => call.method === 'sendChecklist')).toBe(false);
    expect(JSON.stringify(calls[0]?.payload)).not.toContain('sendChecklist');
    expect(JSON.stringify(calls[0]?.payload)).not.toContain('checklist');
  });

  it('R-598 клавиатуры под сообщением нет', async () => {
    await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, taskParagraph);
    const payload = fieldsOf(calls[0]?.payload);
    expect(payload).not.toHaveProperty('reply_markup');
    expect(JSON.stringify(payload)).not.toContain('reply_markup');
    expect(JSON.stringify(payload)).not.toContain('inline_keyboard');
    expect(calls.some((call) => call.method === 'sendMessage')).toBe(false);
  });
});

function paragraph(text: string): CanvasParagraph {
  return { pieces: [{ kind: 'text', text }] };
}

function visibleLine(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visibleLine).join('');
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

function linesOf(message: CanvasRichMessage): string[] {
  return message.blocks.flatMap((block) => visibleLine(block.text).split('\n'));
}

const header = 'ПРОЕКТ: Общественный сенсор · 17.09';

/** Блоки переданы снизу вверх: порядок строк задаёт состав, не порядок полей. */
const composed = renderCanvas({
  projectName: '  Общественный сенсор  ',
  canvasDate: '2026-09-17',
  sections: {
    dynamics: [paragraph('динамика')],
    divergence: [paragraph('расхождение')],
    github: [paragraph('github')],
    blockers: [paragraph('мешает')],
    plan: [paragraph('следующий шаг: план')],
    tasks: [paragraph('прямо сейчас: задачи')],
    next: [paragraph('следующий шаг: далее')],
    inProgress: [paragraph('прямо сейчас: в работе')],
    done: [paragraph('уже сделано: срез')],
    person: [paragraph('человек')],
    backlog: [paragraph('уже сделано: доля')],
  },
});

const composedLines = linesOf(composed);

describe('P-1 P-2 состав канваса и шапка', () => {
  it('R-107 ПРОЕКТ: Общественный сенсор', () => {
    expect(composedLines[0]).toBe(header);
    expect(composedLines[0]).toContain('ПРОЕКТ: Общественный сенсор');
  });

  it('R-108 17.09', () => {
    expect(composedLines[0]).toBe(header);
    expect(composedLines[0]).toContain('17.09');
    expect(composedLines[0]).not.toContain('2026');
    expect(linesOf(renderCanvas({ projectName: 'Общественный сенсор', canvasDate: '2026-09-07' }))[0]).toBe(
      'ПРОЕКТ: Общественный сенсор · 07.09',
    );
  });

  it('R-087 что уже сделано', () => {
    const share = composedLines.indexOf('уже сделано: доля');
    const slice = composedLines.indexOf('уже сделано: срез');
    const now = composedLines.indexOf('прямо сейчас: в работе');
    expect(share).toBeGreaterThan(0);
    expect(slice).toBeGreaterThan(share);
    expect(now).toBeGreaterThan(share);
    expect(slice).toBeGreaterThan(now);
  });

  it('R-088 что делается прямо сейчас', () => {
    const issues = composedLines.indexOf('прямо сейчас: в работе');
    const tasks = composedLines.indexOf('прямо сейчас: задачи');
    expect(tasks).toBeGreaterThan(composedLines.indexOf('уже сделано: доля'));
    expect(issues).toBeGreaterThan(tasks);
    expect(tasks).toBeLessThan(composedLines.indexOf('мешает'));
  });

  it('R-089 что мешает', () => {
    const blockers = composedLines.indexOf('мешает');
    expect(blockers).toBeGreaterThan(composedLines.indexOf('следующий шаг: план'));
    expect(blockers).toBeLessThan(composedLines.indexOf('github'));
  });

  it('R-090 какой следующий шаг', () => {
    const ahead = composedLines.indexOf('следующий шаг: далее');
    const plan = composedLines.indexOf('следующий шаг: план');
    expect(ahead).toBeGreaterThan(composedLines.indexOf('прямо сейчас: в работе'));
    expect(plan).toBeLessThan(ahead);
    expect(plan).toBeLessThan(composedLines.indexOf('мешает'));
  });

  it('R-475 состав сверху вниз', () => {
    expect(CANVAS_SECTION_ORDER).toEqual([
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
    ]);
    expect(composedLines).toEqual([
      header,
      'уже сделано: доля',
      'прямо сейчас: задачи',
      'следующий шаг: план',
      'мешает',
      'человек',
      'прямо сейчас: в работе',
      'следующий шаг: далее',
      'уже сделано: срез',
      'github',
      'расхождение',
      'динамика',
    ]);
    const gap = renderCanvas({
      projectName: 'Общественный сенсор',
      canvasDate: '2026-09-17',
      sections: {
        plan: [],
        github: [paragraph('github')],
        done: [paragraph('уже сделано: срез')],
      },
    });
    expect(linesOf(gap)).toEqual([header, 'уже сделано: срез', 'github']);
  });

  it('R-990 блок свёрнут, пока его не раскрыли', () => {
    expect(composed.blocks.some((block) => block.type === 'expandable_blockquote')).toBe(true);
  });

  it('R-991 первая строка блока — строка человека, она видна и свёрнутым', () => {
    const fold = composed.blocks.find((block) => block.type === 'expandable_blockquote');
    if (fold?.type !== 'expandable_blockquote') throw new Error('нет раскрывающегося блока');
    expect(visibleLine(fold.text).split('\n')[0]).toBe('человек');
  });

  it('R-993 строка GitHub, расхождение и динамика под блоком и видны сразу', () => {
    const fold = composed.blocks.find((block) => block.type === 'expandable_blockquote');
    if (fold?.type !== 'expandable_blockquote') throw new Error('нет раскрывающегося блока');
    const inside = visibleLine(fold.text);
    expect(inside).not.toContain('github');
    expect(inside).not.toContain('расхождение');
    expect(inside).not.toContain('динамика');
    const outside = composed.blocks.filter((block) => block.type === 'paragraph').map((block) => visibleLine(block.text));
    const githubAt = outside.indexOf('github');
    expect(githubAt).toBeGreaterThan(-1);
    expect(outside.indexOf('расхождение')).toBeGreaterThan(githubAt);
    expect(outside.indexOf('динамика')).toBeGreaterThan(outside.indexOf('расхождение'));
  });

  it('R-976 срез issues в раскрывающемся блоке, строка GitHub снаружи', () => {
    const fold = composed.blocks.find((block) => block.type === 'expandable_blockquote');
    expect(fold?.type).toBe('expandable_blockquote');
    if (fold?.type !== 'expandable_blockquote') throw new Error('нет раскрывающегося блока');
    const inside = visibleLine(fold.text);
    expect(inside).toContain('человек');
    expect(inside).toContain('уже сделано: срез');
    expect(inside).not.toContain('github');
    expect(inside).not.toContain('расхождение');
    expect(inside).not.toContain('динамика');
    const github = composed.blocks.find((block) => block.type === 'paragraph' && visibleLine(block.text) === 'github');
    expect(github).toBeDefined();
    const foldAt = composed.blocks.indexOf(fold);
    const githubAt = github === undefined ? -1 : composed.blocks.indexOf(github);
    expect(githubAt).toBeGreaterThan(foldAt);
  });

  it('R-977 заголовок шапки жирный', () => {
    expect(composed.blocks[0]?.text).toEqual({ type: 'bold', text: header });
  });
});
