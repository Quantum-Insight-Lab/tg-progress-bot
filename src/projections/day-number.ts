export type DayNumberItem = {
  taskId: string;
  listId: string;
  carriedFromListId: string | null;
};

export function dayNumberOf(
  item: DayNumberItem,
  items: readonly DayNumberItem[],
): number {
  let day = 1;
  let fromId = item.carriedFromListId;
  const seen = new Set<string>();
  while (fromId !== null && !seen.has(fromId)) {
    seen.add(fromId);
    day += 1;
    const previous = items.find(
      (entry) => entry.listId === fromId && entry.taskId === item.taskId,
    );
    fromId = previous?.carriedFromListId ?? null;
  }
  return day;
}
