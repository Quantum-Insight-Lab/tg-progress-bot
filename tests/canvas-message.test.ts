import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transformer } from 'grammy';
import {
  CANVAS_LINK_STYLE,
  renderCanvasMessage,
  type CanvasRichMessage,
  type CanvasRichText,
  type CanvasTextButton,
} from '../src/projections/canvas-message.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { sendCanvasMessage } from '../src/telegram/canvas-message.ts';
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
  return typeof part !== 'string' && !Array.isArray(part);
}

function buttonsOf(message: CanvasRichMessage): CanvasTextButton[] {
  const found: CanvasTextButton[] = [];
  const walk = (text: CanvasRichText): void => {
    if (typeof text === 'string') return;
    if (Array.isArray(text)) {
      for (const part of text) walk(part);
      return;
    }
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

  it('R-598 клавиатуры под сообщением нет', async () => {
    await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: 42 }, taskParagraph);
    const payload = fieldsOf(calls[0]?.payload);
    expect(payload).not.toHaveProperty('reply_markup');
    expect(JSON.stringify(payload)).not.toContain('reply_markup');
    expect(JSON.stringify(payload)).not.toContain('inline_keyboard');
    expect(calls.some((call) => call.method === 'sendMessage')).toBe(false);
  });
});
