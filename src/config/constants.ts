/** Константы из docs/pda/05-constants.md. Домен берёт пороги только отсюда (S-8); значение меняется вместе с карточкой константы. */

/** C-1, дни без галочки до `BLOCKED`. */
export const STALE_DAYS = 2;
/** C-2, issues в каждой части среза канваса. */
export const CANVAS_SLICE_SIZE = 5;
/** C-3, названий в строке отчёта. */
export const REPORT_LIST_LIMIT = 5;
/** C-4, задач в строке «Дальше». */
export const REPORT_NEXT_TASKS = 3;
/** C-5, точек в строке динамики. */
export const DYNAMICS_POINTS = 4;
/** C-6, дни между точками динамики. */
export const DYNAMICS_STEP = 7;
/** C-7 */
export const DEFAULT_PRIORITY = 'normal';
/** C-8, символов в rich message. */
export const RICH_MESSAGE_MAX_CHARS = 32768;
/** C-9, блоков в rich message. */
export const RICH_MESSAGE_MAX_BLOCKS = 500;
/** C-10, минуты между прогонами сверки зеркала. */
export const RECONCILE_INTERVAL = 15;
/** C-11, дни коммитов в зеркале. */
export const COMMITS_TAIL_DAYS = 7;
