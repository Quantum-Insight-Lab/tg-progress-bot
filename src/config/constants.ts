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
/** C-12, проценты оставшегося лимита GitHub App: ниже — дневная сводка. */
export const GITHUB_RATE_FLOOR = 20;
/** C-13, во сколько интервалов сверки укладывается свежий факт зеркала. */
export const MIRROR_LAG_INTERVALS = 2;
/** C-14, минут в часе: сдвиг хранится целыми часами. */
export const MINUTES_PER_HOUR = 60;
/** C-15, часов в сутках. Обёртка сдвига не переходит через них. */
export const HOURS_PER_DAY = 24;
/** C-16, самый западный сдвиг, часы к западу от UTC. */
export const UTC_OFFSET_WEST_HOURS = 12;
/** C-17, самый восточный сдвиг, часы к востоку от UTC. */
export const UTC_OFFSET_EAST_HOURS = 14;
/** C-18, клеток в полоске доли на канвасе. */
export const CANVAS_SHARE_CELLS = 10;
