/**
 * Minutes are stored as decimal minutes (e.g. 23.6167 = 23 min, 37 sec).
 * Rounding that decimal directly (toFixed(2) -> "23.62") reads like a
 * MM.SS clock time but isn't one — the digits after the point aren't
 * seconds. This converts properly (fraction * 60, base 60) so the
 * seconds portion is always a real 00-59 clock value.
 */
export function formatMinutesClock(decimalMinutes: number | null | undefined): string {
  const total = Math.max(0, decimalMinutes ?? 0);
  const mins = Math.floor(total);
  let secs = Math.round((total - mins) * 60);
  let m = mins;
  if (secs === 60) {
    secs = 0;
    m += 1;
  }
  return `${m}.${secs.toString().padStart(2, '0')}`;
}
