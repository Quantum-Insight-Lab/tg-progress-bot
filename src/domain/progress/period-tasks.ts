import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/** Задача периода. Счётчики отчёта читают только её. */
export const PERIOD_TASK_COUNTER_TASK = 'task';

/** Коммит периода. В счётчики задач не входит. */
export const PERIOD_TASK_COUNTER_COMMIT = 'commit';

/** Issue периода. В счётчики задач не входит, в том числе `not_planned`. */
export const PERIOD_TASK_COUNTER_ISSUE = 'issue';

/** Переход в `DONE`. В строке отчёта это «подтверждено». */
const ENTERED_DONE = 'DONE';

/** Переход в `CANCELLED`. В строке отчёта это «отменено». */
const ENTERED_CANCELLED = 'CANCELLED';

/**
 * Переход в `BLOCKED`. В строке отчёта это «встало в блок».
 * Уже `BLOCKED` на начало периода сюда не входит: это не первый вход.
 */
const ENTERED_BLOCKED = 'BLOCKED';

/**
 * Задача на период.
 * `statusAtStart === null` — задачи не было, она создана внутри периода.
 * `entered` — статусы, в которые она входила внутри периода.
 * Повтор входа и порядок списка задачу не удваивают.
 */
export interface PeriodTaskCounterTask {
  kind: typeof PERIOD_TASK_COUNTER_TASK;
  key: string;
  statusAtStart: string | null;
  entered: readonly string[];
}

/** Issue или коммит рядом с задачами. Счётчики их не читают. */
export interface PeriodTaskCounterOther {
  kind: typeof PERIOD_TASK_COUNTER_COMMIT | typeof PERIOD_TASK_COUNTER_ISSUE;
  key: string;
  /**
   * Причина закрытия issue, если это issue.
   * `not_planned` и `completed` в число задач не входят.
   */
  stateReason?: string;
}

/** Факты, из которых считаются счётчики задач. Строка отчёта сюда не передаётся. */
export type PeriodTaskCounterFact = PeriodTaskCounterTask | PeriodTaskCounterOther;

/**
 * Счётчики задач за период.
 * Это не канвас и не коммиты: четыре числа из переходов задач.
 */
export interface PeriodTaskCounters {
  confirmed: number;
  created: number;
  cancelled: number;
  blocked: number;
}

function factKey(value: string, code: typeof DOMAIN_ERROR.PERIOD_TASK_KEY | typeof DOMAIN_ERROR.PERIOD_FACT_KEY, message: string): string {
  const key = value.trim();
  if (key.length === 0) throw new DomainError(code, message);
  return key;
}

function statusWord(value: string): string {
  const status = value.trim();
  if (status.length === 0) throw new DomainError(DOMAIN_ERROR.PERIOD_TASK_STATUS, 'Статус перехода задачи не пустой');
  return status;
}

function enteredOnce(entered: readonly string[], status: string): boolean {
  for (const step of entered) {
    if (step === status) return true;
  }
  return false;
}

/**
 * Счётчики задач за период.
 * «Подтверждено» — задача входила в `DONE` и на начало ещё не была `DONE`.
 * «Создано» — на начало периода задачи не было.
 * «Отменено» — задача входила в `CANCELLED` и на начало ещё не была `CANCELLED`.
 * «Встало в блок» — задача входила в `BLOCKED` и на начало ещё не была `BLOCKED`.
 * Повтор тех же фактов даёт те же числа. Issues и коммиты числа не меняют.
 */
export function periodTaskCounters(facts: readonly PeriodTaskCounterFact[]): PeriodTaskCounters {
  let confirmed = 0;
  let created = 0;
  let cancelled = 0;
  let blocked = 0;
  const seen = new Set<string>();

  for (const fact of facts) {
    if (fact.kind !== PERIOD_TASK_COUNTER_TASK) {
      factKey(fact.key, DOMAIN_ERROR.PERIOD_FACT_KEY, 'У факта периода есть id');
      continue;
    }
    const key = factKey(fact.key, DOMAIN_ERROR.PERIOD_TASK_KEY, 'У задачи периода есть id');
    if (seen.has(key)) {
      throw new DomainError(DOMAIN_ERROR.PERIOD_TASK_DUPLICATE, 'Задача периода встречается один раз');
    }
    seen.add(key);

    const start = fact.statusAtStart === null ? null : statusWord(fact.statusAtStart);
    const entered = fact.entered.map(statusWord);
    if (start === null) created += 1;
    if (start !== ENTERED_DONE && enteredOnce(entered, ENTERED_DONE)) confirmed += 1;
    if (start !== ENTERED_CANCELLED && enteredOnce(entered, ENTERED_CANCELLED)) cancelled += 1;
    if (start !== ENTERED_BLOCKED && enteredOnce(entered, ENTERED_BLOCKED)) blocked += 1;
  }

  return { confirmed, created, cancelled, blocked };
}
