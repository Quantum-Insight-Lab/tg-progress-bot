import { REPORT_LIST_LIMIT } from '../config/constants.ts';

/**
 * P-13. Строка «Задачи» в блоке проекта отчёта.
 * Четыре счётчика периода печатаются всегда, ноль тоже: макет держит «отменено 0».
 * Числа приходят из фактов периода. Issues и коммиты в строку не подмешиваются.
 * «Снято» — те же задачи, что вошли в «отменено». Пустой список строку не занимает.
 */

/** Подпись строки. Другого слова у блока нет. */
export const REPORT_TASKS_LABEL = 'Задачи';

/** Промежуток между счётчиками, как в макете отчёта. */
export const REPORT_TASKS_GAP = ' · ';

/** Четыре числа строки. Отбор — в домене, здесь только печать. */
export interface ReportTaskCounters {
  confirmed: number;
  created: number;
  cancelled: number;
  blocked: number;
}

function countText(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error('счётчик задач отчёта — целое от нуля');
  return String(value);
}

/**
 * Одна строка: «Задачи: подтверждено N · создано N · отменено N · встало в блок N».
 * Ноль остаётся в тексте. Названия issues и коммиты сюда не входят.
 */
export function reportTasksLine(counters: ReportTaskCounters): string {
  const parts = [
    `подтверждено ${countText(counters.confirmed)}`,
    `создано ${countText(counters.created)}`,
    `отменено ${countText(counters.cancelled)}`,
    `встало в блок ${countText(counters.blocked)}`,
  ];
  return `${REPORT_TASKS_LABEL}: ${parts.join(REPORT_TASKS_GAP)}`;
}

/** Подпись списка снятых. Другого слова у него нет. */
export const REPORT_REMOVED_LABEL = 'Снято';

/** Кто снял, когда задачу сняла система при удалении участника. */
export const REPORT_CANCELLED_BY_SYSTEM = 'система';

/** Снятая за период задача. Имя того, кто снял, уже выбрано. */
export interface ReportCancelledLine {
  number: number;
  title: string;
  cancelledByName: string;
}

function removedItem(task: ReportCancelledLine): string {
  if (!Number.isInteger(task.number) || task.number < 1) throw new Error('номер снятой задачи — целое больше нуля');
  const title = task.title.trim();
  const name = task.cancelledByName.trim();
  if (title.length === 0) throw new Error('у снятой задачи есть название');
  if (name.length === 0) throw new Error('у снятой задачи есть тот, кто снял');
  return `${String(task.number)} — ${title} — ${name}`;
}

/**
 * «Снято: N — название — кто снял», по строке на задачу.
 * Пустой список ничего не печатает. Длиннее лимита отчёта — число и первые названия.
 */
export function reportCancelledLines(tasks: readonly ReportCancelledLine[]): string[] {
  if (tasks.length === 0) return [];
  const items = tasks.map(removedItem);
  if (items.length <= REPORT_LIST_LIMIT) return items.map((item) => `${REPORT_REMOVED_LABEL}: ${item}`);
  const shown = items.slice(0, REPORT_LIST_LIMIT).join(', ');
  return [`${REPORT_REMOVED_LABEL}: ${String(items.length)}, среди них ${shown}`];
}
