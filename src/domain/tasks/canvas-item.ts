import { DOMAIN_ERROR, DomainError } from '../shared/errors.ts';

/**
 * Пункт канваса — задача, нарисованная на канвасе, и её место.
 * Кнопки в строку не складываются: их рисуют из статуса задачи.
 * Ключ — id. Перенос ссылается на канвас и пуст, пока пункт не перенесён.
 */
export interface CanvasItem {
  id: string;
  canvasId: string;
  taskId: string;
  position: number;
  /** Пусто, пока пункт не перенесён с другого канваса. */
  carriedFromCanvasId: string | null;
}

/** Этих полей в пункте нет: кнопки живут в статусе задачи, не в строке. */
export const ABSENT_CANVAS_ITEM_BUTTONS = [
  'button',
  'buttons',
  'callbackData',
  'callback_data',
  'keyboard',
  'markup',
] as const;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

function buttonField(key: string): boolean {
  for (const field of ABSENT_CANVAS_ITEM_BUTTONS) {
    if (field === key) return true;
  }
  return false;
}

/** Поля пункта. Кнопки отклоняются: их рисуют из статуса задачи. */
export function defineCanvasItem(input: {
  id: string;
  canvasId: string;
  taskId: string;
  position: number;
  carriedFromCanvasId: string | null;
}): CanvasItem {
  for (const key of Object.keys(input)) {
    if (buttonField(key)) {
      throw new DomainError(
        DOMAIN_ERROR.CANVAS_ITEM_BUTTONS,
        'Кнопки задачи в таблицу не складываются: их рисуют из статуса задачи',
      );
    }
  }
  if (blank(input.id)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ITEM_ID_BLANK, 'У пункта канваса есть id');
  }
  if (blank(input.canvasId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ITEM_CANVAS_BLANK, 'У пункта канваса есть канвас');
  }
  if (blank(input.taskId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ITEM_TASK_BLANK, 'У пункта канваса есть задача');
  }
  if (!Number.isInteger(input.position)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ITEM_POSITION, 'Место пункта — целое число');
  }
  if (input.carriedFromCanvasId !== null && blank(input.carriedFromCanvasId)) {
    throw new DomainError(DOMAIN_ERROR.CANVAS_ITEM_CARRIED_BLANK, 'Канвас переноса либо пуст, либо задан');
  }
  return {
    id: input.id,
    canvasId: input.canvasId,
    taskId: input.taskId,
    position: input.position,
    carriedFromCanvasId: input.carriedFromCanvasId,
  };
}

/** Порядок пунктов канваса — по месту. Список одного канваса приходит уже отобранным. */
export function byCanvasPosition(items: readonly CanvasItem[]): CanvasItem[] {
  const ordered = [...items];
  ordered.sort((left, right) => {
    if (left.position < right.position) return -1;
    if (left.position > right.position) return 1;
    return 0;
  });
  return ordered;
}
