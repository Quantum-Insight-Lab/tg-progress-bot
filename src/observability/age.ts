const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

function durationLabel(lagMs: number): string {
  const seconds = Math.max(0, Math.floor(lagMs / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) {
    return `${String(seconds)} с`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)} мин`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${String(hours)} ч`;
}

/** Возраст зеркала GitHub для экранов (#22). */
export function formatGithubDataAge(
  lagMs: number | null,
  staleAfterMs: number,
): string {
  if (lagMs === null) {
    return "Данные GitHub: нет";
  }
  const label = durationLabel(lagMs);
  if (lagMs >= staleAfterMs) {
    return `Данные GitHub устарели: ${label}`;
  }
  return `Данные GitHub: ${label}`;
}
