import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transformer } from 'grammy';
import {
  BACKLOG_ISSUE_CLOSED,
  BACKLOG_ISSUE_COMPLETED,
  BACKLOG_ISSUE_NOT_PLANNED,
  BACKLOG_ISSUE_OPEN,
  backlogShare,
  type BacklogIssue,
} from '../src/domain/progress/backlog-share.ts';
import { personBacklogPlace, type PersonBacklogIssue } from '../src/domain/progress/person-place.ts';
import { tasksBlock } from '../src/domain/tasks/github-link.ts';
import {
  TASK_PRIORITY_HIGH,
  TASK_STATUS_DONE,
  TASK_STATUS_IN_PROGRESS,
  tasksStandingInBlock,
} from '../src/domain/tasks/status.ts';
import { defineTask } from '../src/domain/tasks/task.ts';
import { backlogShareParagraphs } from '../src/projections/backlog-line.ts';
import {
  BLOCKER_DEFAULT_BRANCH_CI,
  BLOCKERS_BLOCK_HEADING,
  blockersBlockParagraphs,
} from '../src/projections/blockers-block.ts';
import type { CanvasRichText } from '../src/projections/canvas-message.ts';
import { personLineFromPlace, personLineParagraphs } from '../src/projections/person-line.ts';
import { TASKS_BLOCK_HEADING, tasksBlockParagraphs, type TaskFirstLine } from '../src/projections/tasks-block.ts';
import { createTelegramBot } from '../src/telegram/bot.ts';
import { sendCanvasMessage } from '../src/telegram/canvas-message.ts';
import { prepareCanvasMessage } from '../src/telegram/canvas-fit.ts';
import { testBotInfo } from './bot-info.ts';

const REPOSITORY_ID = '11';
const TOPIC_ID = 42;
const PROJECT = 'Общественный сенсор';
const CANVAS_DATE = '2026-09-17';
const TODAY_TITLE = 'Классификация сигнала';
const DONE_TITLE = 'Уже подтверждено';
const BLOCKER_REASON = 'ждём макет';

const shareIssues: BacklogIssue[] = [
  ...Array.from({ length: 13 }, () => ({ state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_COMPLETED })),
  ...Array.from({ length: 18 }, () => ({ state: BACKLOG_ISSUE_OPEN, stateReason: null })),
  { state: BACKLOG_ISSUE_CLOSED, stateReason: BACKLOG_ISSUE_NOT_PLANNED },
];

function personIssue(
  issueNumber: number,
  state: string,
  stateReason: string | null,
  assignees: readonly string[],
): PersonBacklogIssue {
  return { repositoryId: REPOSITORY_ID, issueNumber, state, stateReason, assignees };
}

const personIssues: PersonBacklogIssue[] = [
  personIssue(1, BACKLOG_ISSUE_CLOSED, BACKLOG_ISSUE_COMPLETED, ['andrey']),
  personIssue(2, BACKLOG_ISSUE_CLOSED, BACKLOG_ISSUE_COMPLETED, ['andrey']),
  personIssue(3, BACKLOG_ISSUE_OPEN, null, ['andrey']),
  personIssue(4, BACKLOG_ISSUE_OPEN, null, ['other']),
  personIssue(5, BACKLOG_ISSUE_OPEN, null, ['other']),
  personIssue(6, BACKLOG_ISSUE_OPEN, null, []),
  personIssue(7, BACKLOG_ISSUE_CLOSED, BACKLOG_ISSUE_NOT_PLANNED, ['andrey']),
];

function task(number: number, title: string, status: string, completedAt: string | null) {
  return defineTask({
    id: `task-${String(number)}`,
    projectId: 'project-1',
    number,
    title,
    status,
    priority: TASK_PRIORITY_HIGH,
    assigneeId: 'user-1',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    completedAt,
  });
}

const standing = tasksStandingInBlock(
  tasksBlock([
    { source: 'task', task: task(7, TODAY_TITLE, TASK_STATUS_IN_PROGRESS, null) },
    { source: 'task', task: task(8, DONE_TITLE, TASK_STATUS_DONE, '2026-09-16T00:00:00.000Z') },
    { source: 'github', fact: 'issue' },
  ]),
).map(
  (item): TaskFirstLine => ({
    number: item.number,
    title: item.title,
    status: item.status,
    day: 3,
    priority: item.priority,
  }),
);

const share = backlogShare(shareIssues);
const person = { name: 'Андрей', place: personBacklogPlace('andrey', REPOSITORY_ID, personIssues) };

function visible(text: CanvasRichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(visible).join('');
  if (text.type === 'bold') return text.text;
  if (text.type === 'bold') return text.text;
  return text.button.text;
}

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

const calls: Captured[] = [];
let bot: ReturnType<typeof createTelegramBot>;

beforeAll(() => {
  bot = createTelegramBot('test-token', testBotInfo);
  bot.api.config.use(capture(calls));
});

beforeEach(() => {
  calls.length = 0;
});

/** Канвас топика: те же проекции, что процесс кладёт в одно rich message. */
async function topicLines(): Promise<string[]> {
  const prepared = prepareCanvasMessage({
    projectName: PROJECT,
    canvasDate: CANVAS_DATE,
    sections: {
      backlog: backlogShareParagraphs(share),
      person: personLineParagraphs(personLineFromPlace(person)),
      tasks: tasksBlockParagraphs(standing),
      blockers: blockersBlockParagraphs({
        reasons: [{ taskNumber: 7, reason: BLOCKER_REASON }],
        pullRequests: [{ pullRequestNumber: 12, ciRed: false }],
        defaultBranchCiRed: true,
      }),
    },
  });
  if (prepared.status !== 'ready') throw new Error('канвас не собрался');
  await sendCanvasMessage(bot.api, { chatId: '-1001', messageThreadId: TOPIC_ID }, prepared.message);
  const payload = fieldsOf(calls[0]?.payload);
  const message = payload.rich_message;
  if (typeof message !== 'object' || message === null || !('blocks' in message)) throw new Error('rich message');
  const blocks = message.blocks;
  if (!Array.isArray(blocks)) throw new Error('блоки канваса');
  return blocks.map((block: { text: CanvasRichText }) => visible(block.text));
}

const SHARE_TOTAL = 13 + 18;

describe('M-1 M-2 критерий успеха', () => {
  it('R-951 состояние читается с канваса топика, без GitHub и без вопроса разработчику', async () => {
    const lines = await topicLines();
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage']);
    expect(fieldsOf(calls[0]?.payload).message_thread_id).toBe(TOPIC_ID);
    expect(lines[0]).toBe(`ПРОЕКТ: ${PROJECT} · 17.09`);
    expect(lines.join('\n')).toContain('Сделано по проекту:');
    expect(lines.join('\n')).toContain('Андрей по issues:');
    expect(lines).toContain(TASKS_BLOCK_HEADING);
    expect(lines.join('\n')).toContain(TODAY_TITLE);
    expect(lines).toContain(BLOCKERS_BLOCK_HEADING);
    expect(lines.join('\n')).toContain(BLOCKER_REASON);
    expect(JSON.stringify(calls[0]?.payload)).not.toContain('github.com');
  });

  it('R-952 одно сообщение топика отвечает на пять вопросов сразу', async () => {
    const lines = await topicLines();
    const text = lines.join('\n');
    const shareAt = text.indexOf('Сделано по проекту:');
    const personAt = text.indexOf('Андрей по issues:');
    const tasksAt = text.indexOf(TASKS_BLOCK_HEADING);
    const blockersAt = text.indexOf(BLOCKERS_BLOCK_HEADING);
    expect(shareAt).toBeGreaterThan(0);
    expect(tasksAt).toBeGreaterThan(shareAt);
    expect(blockersAt).toBeGreaterThan(tasksAt);
    expect(personAt).toBeGreaterThan(blockersAt);
    expect(calls).toHaveLength(1);
  });

  it('R-953 какая доля проекта уже сделана', async () => {
    expect(share.completed).toBe(13);
    expect(share.remaining).toBe(18);
    expect(share.ratio).not.toBeNull();
    const total = share.completed + share.remaining;
    expect(total).toBe(SHARE_TOTAL);
    const percent = Math.round((share.completed * 100) / total);
    const lines = await topicLines();
    expect(lines.join('\n')).toContain(`Сделано по проекту: ${String(percent)}% · осталось ${String(share.remaining)} из ${String(total)}`);
  });

  it('R-954 сколько issues осталось', async () => {
    const lines = await topicLines();
    expect(share.remaining).toBe(18);
    expect(lines.join('\n')).toContain(`осталось ${String(share.remaining)} из ${String(SHARE_TOTAL)}`);
    expect(lines.join('\n')).not.toContain(`из ${String(SHARE_TOTAL + 1)}`);
  });

  it('R-955 где в бэклоге стоит человек', async () => {
    expect(person.place.kind).toBe('slice');
    if (person.place.kind !== 'slice') return;
    expect(person.place.done).toEqual([1, 2]);
    expect(person.place.now).toEqual([3]);
    expect(person.place.next).toEqual([4, 5, 6]);
    const lines = await topicLines();
    expect(lines).toContain(
      `Андрей по issues: сделал ${String(person.place.done.length)} · сейчас на нём ${String(person.place.now.length)} · дальше в репозитории ${String(person.place.next.length)}`,
    );
  });

  it('R-956 какие задачи на нём сегодня', async () => {
    expect(standing.map((item) => item.title)).toEqual([TODAY_TITLE]);
    const lines = await topicLines();
    const tasksAt = lines.indexOf(TASKS_BLOCK_HEADING);
    const taskLine = lines[tasksAt + 1] ?? '';
    expect(taskLine).toContain(TODAY_TITLE);
    expect(taskLine).toContain('7');
    expect(lines.join('\n')).not.toContain(DONE_TITLE);
  });

  it('R-957 что блокирует работу', async () => {
    const lines = await topicLines();
    const blockersAt = lines.indexOf(BLOCKERS_BLOCK_HEADING);
    expect(lines.slice(blockersAt + 1, blockersAt + 4)).toEqual([
      `7 — ${BLOCKER_REASON}`,
      BLOCKER_DEFAULT_BRANCH_CI,
      'PR #12 без движения',
    ]);
  });
});
