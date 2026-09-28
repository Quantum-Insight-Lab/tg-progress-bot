import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTelegramBot, getTelegramBot } from '../src/telegram/bot.ts';
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

  it('grammY и new Bot живут только в src/telegram', () => {
    const sources = filesIn('src');
    const grammy = sources.filter((path) => readFileSync(path, 'utf8').includes("from 'grammy'"));
    const constructed = sources.filter((path) => readFileSync(path, 'utf8').includes('new Bot'));
    expect(grammy.every((path) => path.startsWith('src/telegram/'))).toBe(true);
    expect(grammy.length).toBeGreaterThan(0);
    expect(constructed).toEqual(['src/telegram/bot.ts']);
  });
});
