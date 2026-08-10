/**
 * Basketball seasons span two calendar years and roll over around
 * August/September. "2026-27" starts in fall 2026 and runs through
 * mid-2027 — so from August onward the season named after the current
 * year is "current"; before that, it's still last year's season.
 *
 * Mirrors electron/db/seed.js's currentSeasonLabel() exactly — keep the
 * two in sync since one runs in the main process, this one in the renderer.
 */
export function currentSeasonLabel(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const startYear = month >= 8 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
