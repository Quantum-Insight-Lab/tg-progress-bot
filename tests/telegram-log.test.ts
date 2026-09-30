import type { Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccessGate } from '../src/domain/projects/access.ts';
import type { UserRegistration } from '../src/domain/projects/user.ts';
import type { Clock } from '../src/domain/shared/clock.ts';
import { DOMAIN_ERROR, DomainError, type DomainErrorCode } from '../src/domain/shared/errors.ts';
import { attachAccessGuard } from '../src/telegram/access-guard.ts';
import { attachBlockerAnswer } from '../src/telegram/blocker-answer.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { attachChatBinding } from '../src/telegram/chat-binding.ts';
import { attachProjectRepository, PROJECT_REPOSITORY_HEADING } from '../src/telegram/connect-repository.ts';
import { attachExecutorTopic, EXECUTOR_TOPIC_HEADING } from '../src/telegram/executor-topic.ts';
import { attachGithubLogin, GITHUB_LOGIN_HEADING } from '../src/telegram/github-login.ts';
import { GUARDED_HANDLERS, type GuardedHandler } from '../src/telegram/handlers.ts';
import { attachInstallationRepositories, REPOSITORIES_HEADING } from '../src/telegram/installation-repositories.ts';
import { attachParticipants, PARTICIPANTS_HEADING } from '../src/telegram/members.ts';
import { attachNewProject, NEW_PROJECT_HEADING } from '../src/telegram/new-project.ts';
import { attachRebuild } from '../src/telegram/rebuild.ts';
import { attachReport } from '../src/telegram/report.ts';
import { attachReportsTopic, REPORTS_TOPIC_HEADING } from '../src/telegram/reports-topic.ts';
import { attachSchedule, SCHEDULE_HEADING } from '../src/telegram/schedule.ts';
import { attachSettings, SETTINGS_HEADING } from '../src/telegram/settings.ts';
import { attachStartCommand } from '../src/telegram/start.ts';
import { attachTaskCancel } from '../src/telegram/task-cancel.ts';
import { attachTaskCommand } from '../src/telegram/task-command.ts';
import { attachTaskMark } from '../src/telegram/task-mark.ts';
import { attachTaskPlan } from '../src/telegram/task-plan.ts';
import { attachTaskReview } from '../src/telegram/task-review.ts';
import { attachUpdateLog } from '../src/telegram/update-log.ts';
import { testBotInfo } from './bot-info.ts';
import { captureLog, type LogLine } from './log-lines.ts';

const clock: Clock = { now: () => new Date('2026-09-30T12:00:00.000Z') };
const log = captureLog({ clock });

const OUTSIDER = 5001;
const MEMBER = 5002;
const GROUP = -1001234567890;
const TOPIC = 17;
const PROJECT_ID = '00000000-0000-4000-8000-000000000010';

/** Текст людей из обновлений ниже. Ни одно слово не должно дойти до лога. */
const PEOPLE_TEXT = ['Альфа', 'Борис', 'Секрет', 'secret-login', 'Europe/Moscow', 'канвас'];

const BLOCKED = { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };

type Place = 'private' | 'topic';

function chatOf(place: Place, fromId: number): Record<string, unknown> {
  if (place === 'private') return { id: fromId, type: 'private', first_name: 'Человек' };
  return { id: GROUP, type: 'supergroup', title: 'Группа', is_forum: true };
}

function message(updateId: number, fromId: number, place: Place, text: string, commandLength?: number): Update {
  const body: Record<string, unknown> = {
    message_id: updateId,
    date: 1700000000,
    chat: chatOf(place, fromId),
    from: { id: fromId, is_bot: false, first_name: 'Человек' },
    text,
  };
  if (place === 'topic') {
    body.message_thread_id = TOPIC;
    body.is_topic_message = true;
  }
  if (commandLength !== undefined) body.entities = [{ type: 'bot_command', offset: 0, length: commandLength }];
  return { update_id: updateId, message: body } as unknown as Update;
}

function command(updateId: number, fromId: number, place: Place, text: string): Update {
  return message(updateId, fromId, place, text, text.split(' ')[0]?.length ?? 0);
}

function callback(updateId: number, fromId: number, place: Place, data: string): Update {
  const origin: Record<string, unknown> = { message_id: 1, date: 1700000000, chat: chatOf(place, fromId), text: 'канвас' };
  if (place === 'topic') origin.message_thread_id = TOPIC;
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: 'Человек' },
      chat_instance: '1',
      data,
      message: origin,
    },
  } as unknown as Update;
}

interface HandlerCase {
  update(updateId: number, fromId: number): Update;
  /** Код, который обработчик превращает в ответ или молчание. */
  refusal: DomainErrorCode;
}

const CASES: Record<GuardedHandler, HandlerCase> = {
  start: { update: (id, from) => command(id, from, 'private', '/start'), refusal: DOMAIN_ERROR.BLANK_NAME },
  'new-project': {
    update: (id, from) => message(id, from, 'private', `${NEW_PROJECT_HEADING}\nАльфа\n\nEurope/Moscow`),
    refusal: DOMAIN_ERROR.PROJECT_CREATOR,
  },
  'chat-binding': {
    update: (id, from) => callback(id, from, 'private', `b:${PROJECT_ID}:${GROUP}`),
    refusal: DOMAIN_ERROR.CHAT_BIND_ACTOR,
  },
  participants: { update: (id, from) => message(id, from, 'private', `${PARTICIPANTS_HEADING}\nАльфа`), refusal: DOMAIN_ERROR.MEMBER_ACTOR },
  'executor-topic': { update: (id, from) => message(id, from, 'private', `${EXECUTOR_TOPIC_HEADING}\nАльфа`), refusal: DOMAIN_ERROR.TOPIC_ACTOR },
  'github-login': {
    update: (id, from) => message(id, from, 'private', `${GITHUB_LOGIN_HEADING}\nsecret-login`),
    refusal: DOMAIN_ERROR.GITHUB_LOGIN_TAKEN,
  },
  'reports-topic': {
    update: (id, from) => message(id, from, 'private', `${REPORTS_TOPIC_HEADING}\nАльфа`),
    refusal: DOMAIN_ERROR.REPORTS_TOPIC_ACTOR,
  },
  schedule: { update: (id, from) => message(id, from, 'private', `${SCHEDULE_HEADING}\nАльфа`), refusal: DOMAIN_ERROR.SCHEDULE_ACTOR },
  settings: { update: (id, from) => message(id, from, 'private', `${SETTINGS_HEADING}\nАльфа`), refusal: DOMAIN_ERROR.SETTINGS_ACTOR },
  'installation-repositories': {
    update: (id, from) => message(id, from, 'private', REPOSITORIES_HEADING),
    refusal: DOMAIN_ERROR.REPOSITORY_ACCESS,
  },
  'project-repository': {
    update: (id, from) => message(id, from, 'private', `${PROJECT_REPOSITORY_HEADING}\nАльфа`),
    refusal: DOMAIN_ERROR.PROJECT_REPOSITORY_ACTOR,
  },
  task: { update: (id, from) => command(id, from, 'topic', '/task Секрет'), refusal: DOMAIN_ERROR.TASK_ASSIGNEE_ROLE },
  'task-mark': { update: (id, from) => callback(id, from, 'topic', 'task:mark:1'), refusal: DOMAIN_ERROR.TASK_MARK_ACTOR },
  'task-plan': { update: (id, from) => callback(id, from, 'topic', 'task:plan:1'), refusal: DOMAIN_ERROR.TASK_PLAN_ACTOR },
  'task-review': { update: (id, from) => callback(id, from, 'topic', 'task:confirm:1'), refusal: DOMAIN_ERROR.TASK_CONFIRM_ACTOR },
  'task-cancel': { update: (id, from) => callback(id, from, 'topic', 'task:cancel:1'), refusal: DOMAIN_ERROR.TASK_CANCEL_ACTOR },
  'blocker-answer': { update: (id, from) => callback(id, from, 'topic', 'task:noblock:1'), refusal: DOMAIN_ERROR.BLOCKER_ACTOR },
  report: { update: (id, from) => command(id, from, 'private', '/report'), refusal: DOMAIN_ERROR.REPORT_ACCESS },
  rebuild: { update: (id, from) => command(id, from, 'private', '/rebuild Альфа | Борис'), refusal: DOMAIN_ERROR.REBUILD_ROOT },
};

/** Порт, каждый метод которого отказывает кодом домена. */
function refusing<T extends object>(code: DomainErrorCode): T {
  return new Proxy(
    {},
    {
      get: () => async () => {
        throw new DomainError(code, 'отказ в тесте');
      },
    },
  ) as T;
}

let startRefuses = false;

const registration: UserRegistration = {
  async registerOnStart(input) {
    if (startRefuses) throw new DomainError(DOMAIN_ERROR.BLANK_NAME, 'отказ в тесте');
    return {
      user: { id: '00000000-0000-4000-8000-000000000002', telegramUserId: input.telegramUserId, githubLogin: null, name: input.name, isRoot: false },
      created: true,
    };
  },
};

const gate: AccessGate = {
  screen: async (input) => (input.telegramUserId === String(OUTSIDER) ? 'deny' : 'allow'),
};

type Scripted = (method: string) => unknown;

let failing = false;
let scripted: Scripted | null = null;

const fakeApi = (async (_prev, method) => {
  if (scripted !== null) {
    const answer = scripted(method);
    if (answer instanceof Error) throw answer;
    return answer;
  }
  if (method === 'getChat') return { ok: true, result: { id: GROUP, type: 'supergroup', title: 'Группа', is_forum: true } };
  if (method === 'getChatMember') {
    return { ok: true, result: { status: 'administrator', user: { id: testBotInfo.id, is_bot: true, first_name: testBotInfo.first_name }, can_manage_topics: true } };
  }
  if (failing) return BLOCKED;
  if (method === 'sendMessage') return { ok: true, result: { message_id: 1, date: 1, chat: { id: MEMBER, type: 'private' } } };
  return { ok: true, result: true };
}) as Transformer;

const bot = createTelegramBot('test-token', testBotInfo);

beforeAll(() => {
  bot.api.config.use(fakeApi);
  attachUpdateLog(bot, log.logger, clock);
  attachAccessGuard(bot, gate);
  attachStartCommand(bot, registration);
  attachNewProject(bot, refusing(CASES['new-project'].refusal));
  attachChatBinding(bot, refusing(CASES['chat-binding'].refusal));
  attachGithubLogin(bot, refusing(CASES['github-login'].refusal));
  attachParticipants(bot, refusing(CASES.participants.refusal));
  attachExecutorTopic(bot, refusing(CASES['executor-topic'].refusal));
  attachReportsTopic(bot, refusing(CASES['reports-topic'].refusal));
  attachSchedule(bot, refusing(CASES.schedule.refusal));
  attachReport(bot, refusing(CASES.report.refusal));
  attachRebuild(bot, refusing(CASES.rebuild.refusal));
  attachSettings(bot, refusing(CASES.settings.refusal));
  attachProjectRepository(bot, refusing(CASES['project-repository'].refusal), refusing(CASES['project-repository'].refusal));
  attachInstallationRepositories(bot, refusing(CASES['installation-repositories'].refusal));
  attachTaskCommand(bot, refusing(CASES.task.refusal));
  attachTaskMark(bot, refusing(CASES['task-mark'].refusal));
  attachTaskPlan(bot, refusing(CASES['task-plan'].refusal));
  attachTaskReview(bot, refusing(CASES['task-review'].refusal));
  attachTaskCancel(bot, refusing(CASES['task-cancel'].refusal));
  attachBlockerAnswer(bot, refusing(CASES['blocker-answer'].refusal));
});

beforeEach(() => {
  failing = false;
  scripted = null;
  startRefuses = false;
});

let lastUpdateId = 900;

function linesOf(updateId: number): LogLine[] {
  return log.lines().filter((line) => line.updateId === updateId);
}

function only(lines: readonly LogLine[], step: string): LogLine {
  const found = lines.filter((line) => line.step === step);
  expect(found).toHaveLength(1);
  return found[0] ?? {};
}

async function handle(update: Update): Promise<LogLine[]> {
  await bot.handleUpdate(update);
  return linesOf(update.update_id);
}

async function handleFailing(update: Update): Promise<LogLine[]> {
  await expect(bot.handleUpdate(update)).rejects.toThrow();
  return linesOf(update.update_id);
}

describe('B-17 строки пути обновления по всем обработчикам бота', () => {
  it('в тесте все обработчики из GUARDED_HANDLERS', () => {
    expect(Object.keys(CASES).sort()).toEqual([...GUARDED_HANDLERS].sort());
  });

  it.each(GUARDED_HANDLERS)('INV-16 %s: обновление постороннего — строка guard info, дальше guard его не пускает', async (handler) => {
    lastUpdateId += 1;
    const lines = await handle(CASES[handler].update(lastUpdateId, OUTSIDER));
    expect(only(lines, 'telegram.update')).toMatchObject({ level: 'info', fromId: String(OUTSIDER) });
    if (handler === 'start') {
      expect(only(lines, 'telegram.guard')).toMatchObject({ level: 'info', decision: 'allow', basis: 'start' });
      expect(only(lines, 'telegram.outcome')).toMatchObject({ level: 'info', handler: 'start', outcome: 'replied', code: null });
      return;
    }
    expect(only(lines, 'telegram.guard')).toMatchObject({ level: 'info', decision: 'deny', basis: 'gate' });
    expect(only(lines, 'telegram.outcome')).toMatchObject({ level: 'info', handler: null, outcome: 'denied', code: null, apiFailed: 0 });
    for (const call of lines.filter((line) => line.step === 'telegram.api')) expect(call).toMatchObject({ level: 'info', ok: true });
  });

  it.each(GUARDED_HANDLERS)('%s: отказ домена — строка исхода с кодом DomainError', async (handler) => {
    lastUpdateId += 1;
    const update = CASES[handler].update(lastUpdateId, MEMBER);
    if (handler === 'start') {
      startRefuses = true;
      const lines = await handleFailing(update);
      expect(only(lines, 'telegram.guard')).toMatchObject({ level: 'info', decision: 'allow', basis: 'start' });
      expect(only(lines, 'telegram.outcome')).toMatchObject({
        level: 'error',
        handler: 'start',
        outcome: 'failed',
        code: DOMAIN_ERROR.BLANK_NAME,
        reason: 'отказ в тесте',
      });
      return;
    }
    const lines = await handle(update);
    expect(only(lines, 'telegram.guard')).toMatchObject({ level: 'info', decision: 'allow', basis: 'gate' });
    expect(only(lines, 'telegram.outcome')).toMatchObject({
      level: 'info',
      handler,
      outcome: 'refused',
      code: CASES[handler].refusal,
      apiFailed: 0,
    });
    expect(only(lines, 'telegram.outcome')).not.toHaveProperty('reason');
  });

  it.each(GUARDED_HANDLERS)('%s: ошибка Bot API — строка вызова error с кодом, исход error с причиной', async (handler) => {
    lastUpdateId += 1;
    failing = true;
    const lines = await handleFailing(CASES[handler].update(lastUpdateId, MEMBER));
    const failed = lines.filter((line) => line.step === 'telegram.api' && line.ok === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 'error', errorCode: 403, retryAfter: null, kind: 'other', reason: BLOCKED.description });
    const outcome = only(lines, 'telegram.outcome');
    expect(outcome).toMatchObject({ level: 'error', handler, outcome: 'failed', apiFailed: 1 });
    expect(String(outcome.reason)).toContain('403');
  });
});

describe('B-17 обновление: поля строки и текст людей', () => {
  it('команда: update_id, вид, чат и его тип, топик, отправитель; аргумент команды не пишется', async () => {
    lastUpdateId += 1;
    const lines = await handle(CASES.task.update(lastUpdateId, MEMBER));
    expect(only(lines, 'telegram.update')).toEqual({
      time: '2026-09-30T12:00:00.000Z',
      level: 'info',
      step: 'telegram.update',
      updateId: lastUpdateId,
      kind: 'message',
      chatId: String(GROUP),
      chatType: 'supergroup',
      topicId: TOPIC,
      fromId: String(MEMBER),
      command: '/task',
      callback: null,
    });
  });

  it('callback: пишется вид, ID и номер из данных — нет', async () => {
    lastUpdateId += 1;
    const lines = await handle(callback(lastUpdateId, MEMBER, 'topic', 'task:mark:42'));
    expect(only(lines, 'telegram.update')).toMatchObject({ kind: 'callback_query', chatId: String(GROUP), topicId: TOPIC, command: null, callback: 'task:mark' });
    lastUpdateId += 1;
    const bind = await handle(callback(lastUpdateId, MEMBER, 'private', `b:${PROJECT_ID}:${GROUP}`));
    expect(only(bind, 'telegram.update')).toMatchObject({ chatType: 'private', callback: 'b' });
    expect(JSON.stringify(bind)).not.toContain(PROJECT_ID);
  });

  it('сущность команды шире имени — в строку идёт только имя или ничего', async () => {
    lastUpdateId += 1;
    const lines = await handle(message(lastUpdateId, MEMBER, 'private', '/report Секрет', '/report Секрет'.length));
    expect(only(lines, 'telegram.update')).toMatchObject({ command: null });
  });

  it('обновление без обработчика — исход unhandled; обработчик взял и промолчал — silent', async () => {
    lastUpdateId += 1;
    const plain = await handle(message(lastUpdateId, MEMBER, 'private', 'Секрет: просто текст'));
    expect(only(plain, 'telegram.outcome')).toMatchObject({ level: 'info', handler: null, outcome: 'unhandled', code: null, apiOk: 0 });
    lastUpdateId += 1;
    const quiet = await handle(command(lastUpdateId, MEMBER, 'private', '/rebuild'));
    expect(only(quiet, 'telegram.outcome')).toMatchObject({ level: 'info', handler: 'rebuild', outcome: 'silent', code: null });
  });

  it('текст людей не попадает в лог ни на каком уровне', () => {
    expect(log.raw.length).toBeGreaterThan(0);
    const output = log.raw.join('\n');
    for (const word of PEOPLE_TEXT) expect(output).not.toContain(word);
  });
});

describe('B-17 вызов Bot API вне обновления', () => {
  function steps(): LogLine[] {
    return log.steps('telegram.api').filter((line) => line.updateId === null);
  }

  it('успех — info: метод и чат; тело запроса не пишется', async () => {
    const before = steps().length;
    await bot.api.sendMessage(GROUP, 'Секрет отчёта', { message_thread_id: TOPIC });
    expect(steps().slice(before)).toEqual([
      { time: '2026-09-30T12:00:00.000Z', level: 'info', step: 'telegram.api', method: 'sendMessage', chatId: String(GROUP), updateId: null, ok: true, durationMs: 0 },
    ]);
  });

  it('отказ правки rich message — warn с error_code', async () => {
    scripted = () => ({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
    const before = steps().length;
    await expect(bot.api.editMessageText(GROUP, 5, 'Секрет правки')).rejects.toThrow();
    expect(steps().slice(before)).toEqual([
      expect.objectContaining({
        level: 'warn',
        method: 'editMessageText',
        chatId: String(GROUP),
        ok: false,
        errorCode: 400,
        retryAfter: null,
        kind: 'edit_rejected',
        reason: 'Bad Request: message is not modified',
      }),
    ]);
  });

  it('429 — error с retry_after', async () => {
    scripted = () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } });
    const before = steps().length;
    await expect(bot.api.sendMessage(GROUP, 'Секрет')).rejects.toThrow();
    expect(steps().slice(before)).toEqual([
      expect.objectContaining({ level: 'error', method: 'sendMessage', errorCode: 429, retryAfter: 7, kind: 'rate_limited' }),
    ]);
  });

  it('сбой сети — error без кода с причиной', async () => {
    scripted = () => new Error('сеть недоступна');
    const before = steps().length;
    await expect(bot.api.sendMessage(GROUP, 'Секрет')).rejects.toThrow('сеть недоступна');
    expect(steps().slice(before)).toEqual([
      expect.objectContaining({ level: 'error', method: 'sendMessage', ok: false, errorCode: null, kind: 'other', reason: 'сеть недоступна' }),
    ]);
  });
});
