/** Строка дашборда устойчивости (P-19). Проекция ничего не решает. */
export interface StabilityLine {
  metric: string;
  text: string;
}

/** Текст лички корня: те же строки, что уходят в `alert.sent`. */
export function stabilityDashboard(lines: readonly StabilityLine[]): string {
  if (lines.length === 0) return '';
  return ['Устойчивость', ...lines.map((line) => `${line.metric} ${line.text}`)].join('\n');
}
