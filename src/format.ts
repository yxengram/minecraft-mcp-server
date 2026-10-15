/** Rounds values such as health (often 13.333332061767578) to at most one decimal place. */
export function formatStat(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return String(Math.round(value * 10) / 10);
}
