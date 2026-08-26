/**
 * Player names are stored verbatim as read off the box score (OCR, manual
 * entry, or an imported feed) — often "LASTNAME, FIRSTNAME". Joining several
 * such names with ", " reads as one long comma-separated blur. This converts
 * a single name to "Firstname Lastname" for display; anything that isn't a
 * two-part "Last, First" string (e.g. already-normal names) passes through
 * unchanged rather than risk mangling it.
 */
export function formatPlayerName(raw: string): string {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return raw;
  const toTitleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${toTitleCase(parts[1])} ${toTitleCase(parts[0])}`;
}
