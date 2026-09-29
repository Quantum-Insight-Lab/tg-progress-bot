/**
 * P-13. Строка «Задачи» в блоке проекта отчёта.
 * Четыре счётчика периода печатаются всегда, ноль тоже: макет держит «отменено 0».
 * Числа приходят из фактов периода. Issues и коммиты в строку не подмешиваются.
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
