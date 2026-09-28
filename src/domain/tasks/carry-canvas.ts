import { emit, EVENT_TYPES, type EventJournal } from '../../events/index.ts';
import { calendarDaysBetween } from '../shared/project-time.ts';
import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';
import { defineCanvasItem, type CanvasItem } from './canvas-item.ts';
import type { Canvas } from './canvas.ts';
import { CANVAS_ACTOR_ID, CANVAS_ACTOR_ROLE, CANVAS_SOURCE, CANVAS_SUBJECT } from './place-canvas.ts';
import { carriedToNextCanvas, orderPlan, tasksStandingInBlock, type TaskPriority, type TaskStatus } from './status.ts';

/**
 * Задача на перенос. `createdOn` — календарный день создания в таймзоне проекта:
 * домен не читает часы и не разбирает момент сам.
 */
export interface CarryTask {
  id: string;
  projectId: string;
  assigneeId: string;
  number: number;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  createdOn: string;
}

/**
 * Ключ `canvas.carried_over`: проект, исполнитель и дата канваса назначения.
 * Префикс отделяет факт переноса от `canvas.posted` с теми же полями:
 * ключ журнала уникален на все типы.
 */
export function carriedCanvasKey(projectId: string, assigneeId: string, canvasDate: string): string {
  return `carry+${projectId}+${assigneeId}+${canvasDate}`;
}

/**
 * Пара переноса на дату «сегодня». Назначение — канвас этой даты.
 * Источник — ближайший более ранний канвас того же исполнителя.
 * Будущий канвас и канвас без прошлого дня пару не дают.
 */
export function carryCanvasPair(canvases: readonly Canvas[], today: string): { from: Canvas; to: Canvas } | null {
  const first = canvases[0];
  if (first === undefined) return null;
  let to: Canvas | null = null;
  let from: Canvas | null = null;
  for (const canvas of canvases) {
    if (canvas.projectId !== first.projectId || canvas.assigneeId !== first.assigneeId) continue;
    if (canvas.canvasDate === today) {
      to = canvas;
      continue;
    }
    if (calendarDaysBetween(canvas.canvasDate, today) <= 0) continue;
    if (from === null || calendarDaysBetween(from.canvasDate, canvas.canvasDate) > 0) from = canvas;
  }
  if (to === null || from === null || from.id === to.id) return null;
  return { from, to };
}

/**
 * Незакрытые задачи прошлого канваса на новый канвас того же исполнителя.
 * `IN_PROGRESS`, `BLOCKED`, `REVIEW` и `PLANNED` переносятся. `DONE` и `CANCELLED` — нет.
 * Статус не меняется: `REVIEW` остаётся отмеченной, `PLANNED` остаётся планом.
 * Задача, созданная в день назначения, на этот канвас не переносится.
 */
export function tasksForCarry(from: Canvas, to: Canvas, tasks: readonly CarryTask[]): CarryTask[] {
  if (from.id === to.id) return [];
  if (from.projectId !== to.projectId || from.assigneeId !== to.assigneeId) return [];
  if (calendarDaysBetween(from.canvasDate, to.canvasDate) <= 0) return [];
  const eligible: CarryTask[] = [];
  for (const task of tasks) {
    if (task.projectId !== to.projectId || task.assigneeId !== to.assigneeId) continue;
    if (!carriedToNextCanvas(task.status)) continue;
    if (calendarDaysBetween(task.createdOn, to.canvasDate) <= 0) continue;
    eligible.push(task);
  }
  const byNumber = [...eligible].sort((left, right) => {
    if (left.number < right.number) return -1;
    if (left.number > right.number) return 1;
    return 0;
  });
  return [...tasksStandingInBlock(byNumber), ...orderPlan(byNumber)];
}

export interface CarryItemInsert {
  insert(item: CanvasItem): Promise<void>;
}

/**
 * Пункты нового канваса и один `canvas.carried_over`.
 * Повтор ключа откатывает вставку: второй перенос на ту же дату не пишется.
 */
export async function recordCanvasCarry(
  store: CarryItemInsert,
  journal: EventJournal,
  input: {
    from: Canvas;
    to: Canvas;
    tasks: readonly CarryTask[];
    itemIds: readonly string[];
    occurredAt: Date;
  },
): Promise<readonly string[]> {
  const tasks = tasksForCarry(input.from, input.to, input.tasks);
  if (input.itemIds.length !== tasks.length) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_CARRY_TASKS, 'перенос называет пункт на каждую задачу');
  }
  const taskIds = tasks.map((task) => task.id);
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const itemId = input.itemIds[index];
    if (task === undefined || itemId === undefined) {
      throw new DomainError(DOMAIN_ERROR.CANVAS_CARRY_TASKS, 'перенос называет пункт на каждую задачу');
    }
    await store.insert(
      defineCanvasItem({
        id: itemId,
        canvasId: input.to.id,
        taskId: task.id,
        position: index + 1,
        carriedFromCanvasId: input.from.id,
      }),
    );
  }
  const published = await emit(journal, {
    type: EVENT_TYPES.CANVAS_CARRIED_OVER,
    source: CANVAS_SOURCE,
    idempotencyKey: carriedCanvasKey(input.to.projectId, input.to.assigneeId, input.to.canvasDate),
    payload: {
      from_canvas_id: input.from.id,
      to_canvas_id: input.to.id,
      task_ids: taskIds,
    },
    actor: { id: CANVAS_ACTOR_ID, role: CANVAS_ACTOR_ROLE },
    subject: { entity: CANVAS_SUBJECT, id: input.to.id },
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
  });
  if (published.status === 'duplicate') {
    throw new DomainError(DOMAIN_ERROR.CANVAS_DUPLICATE, 'canvas.carried_over уже записан');
  }
  return taskIds;
}
