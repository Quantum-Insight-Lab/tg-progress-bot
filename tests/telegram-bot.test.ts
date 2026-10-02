import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from 'grammy';
import { describe, expect, it } from 'vitest';
import { createTelegramBot, getTelegramBot, silenceGroupPayload } from '../src/telegram/bot.ts';
import { sendBlockerQuestion } from '../src/telegram/blocker-question.ts';
import { sendReviewReminder } from '../src/telegram/review-reminder.ts';
import { testBotInfo } from './bot-info.ts';

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return entry.name.endsWith('.ts') ? [path.split('\\').join('/')] : [];
  });
}

describe('единственный клиент Telegram', () => {
  it('создаёт один экземпляр grammY и отдаёт его же', () => {
    const bot = createTelegramBot('test-token', testBotInfo);
    expect(getTelegramBot()).toBe(bot);
    expect(() => createTelegramBot('other-token', testBotInfo)).toThrow('экземпляр grammY уже создан');
  });

  it('пустой токен не создаёт экземпляр', () => {
    expect(() => createTelegramBot('')).toThrow('токен бота пуст');
  });

  it('сообщение бота в группу уходит без звука, личка и явный звук остаются', () => {
    const flag = (payload: object): boolean | undefined =>
      'disable_notification' in payload && typeof payload.disable_notification === 'boolean' ? payload.disable_notification : undefined;
    expect(flag(silenceGroupPayload('sendMessage', { chat_id: '-1002757819468', text: 'канвас' }))).toBe(true);
    expect(flag(silenceGroupPayload('sendRichMessage', { chat_id: -100 }))).toBe(true);
    expect(flag(silenceGroupPayload('sendMessage', { chat_id: '457051957', text: 'личка' }))).toBeUndefined();
    expect(flag(silenceGroupPayload('sendMessage', { chat_id: '-100', text: 'вопрос', disable_notification: false }))).toBe(false);
    expect(flag(silenceGroupPayload('editMessageText', { chat_id: '-100', text: 'правка' }))).toBeUndefined();
  });

  it('вопрос о блокере и напоминание руководителю просят звук', async () => {
    const sent: Array<boolean | undefined> = [];
    const api = {
      sendMessage: async (_chat: string | number, _text: string, extra?: { disable_notification?: boolean }) => {
        sent.push(extra?.disable_notification);
        return { message_id: 1 } as Awaited<ReturnType<Api['sendMessage']>>;
      },
    } satisfies Pick<Api, 'sendMessage'>;
    await sendBlockerQuestion(api, { chatId: '-100', messageThreadId: 7, taskNumber: 1, day: 3 });
    await sendReviewReminder(api, { chatId: '-100', messageThreadId: 7, taskNumber: 1, leads: [] });
    expect(sent).toEqual([false, false]);
  });

  it('grammY и new Bot живут только в src/telegram', () => {
    const sources = filesIn('src');
    const grammy = sources.filter((path) => readFileSync(path, 'utf8').includes("from 'grammy'"));
    const constructed = sources.filter((path) => readFileSync(path, 'utf8').includes('new Bot'));
    expect(grammy.every((path) => path.startsWith('src/telegram/'))).toBe(true);
    expect(grammy.length).toBeGreaterThan(0);
    expect(constructed).toEqual(['src/telegram/bot.ts']);
  });
});
