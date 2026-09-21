import { InlineKeyboard } from "grammy";

export const CHECK_CALLBACK_PREFIX = "check:";
export const MENU_CALLBACK_PREFIX = "menu:";
export const PLAN_CALLBACK_PREFIX = "plan:";
export const PRIO_CALLBACK_PREFIX = "pri:";
export const CANCEL_CALLBACK_PREFIX = "can:";
export const ASSIGN_CALLBACK_PREFIX = "asg:";
export const CONFIRM_CALLBACK_PREFIX = "confirm:";

export const TASK_ACT_CALLBACK_PATTERN =
  /^(menu|plan|pri|can|asg|confirm):/;

export const CONFIRM_QUESTION =
  "Похоже, задача выполнена. Подтвердить завершение?";

export function confirmKeyboard(itemId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    "Подтвердить",
    `${CONFIRM_CALLBACK_PREFIX}${itemId}`,
  );
}

export function itemIdFromCallback(data: string | undefined): string | undefined {
  if (data === undefined) {
    return undefined;
  }
  const simple = [
    CHECK_CALLBACK_PREFIX,
    MENU_CALLBACK_PREFIX,
    PLAN_CALLBACK_PREFIX,
    CANCEL_CALLBACK_PREFIX,
    CONFIRM_CALLBACK_PREFIX,
  ];
  for (const prefix of simple) {
    if (data.startsWith(prefix)) {
      return data.slice(prefix.length);
    }
  }
  if (data.startsWith(PRIO_CALLBACK_PREFIX) || data.startsWith(ASSIGN_CALLBACK_PREFIX)) {
    const prefix = data.startsWith(PRIO_CALLBACK_PREFIX)
      ? PRIO_CALLBACK_PREFIX
      : ASSIGN_CALLBACK_PREFIX;
    const rest = data.slice(prefix.length);
    const split = rest.lastIndexOf(":");
    if (split <= 0) {
      return undefined;
    }
    return rest.slice(0, split);
  }
  return undefined;
}
