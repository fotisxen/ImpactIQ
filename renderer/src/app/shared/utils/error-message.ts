/**
 * Electron's ipcRenderer.invoke() wraps every thrown main-process error as
 * "Error invoking remote method 'x': Error: <real message>" (sometimes
 * doubled) — this strips that boilerplate so users see the real message,
 * and falls back to a generic line for anything that still looks like raw
 * JSON/stack-trace noise rather than a real sentence.
 */
export function cleanErrorMessage(message: string): string {
  let cleaned = message;
  for (let i = 0; i < 3; i++) {
    const stripped = cleaned.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^Error:\s*/i, '');
    if (stripped === cleaned) break;
    cleaned = stripped;
  }
  cleaned = cleaned.trim();

  const looksUnreadable = cleaned.length > 220 || /^\{.*\}$/.test(cleaned) || cleaned.includes('\n    at ');
  if (looksUnreadable || !cleaned) {
    return 'Something went wrong. Please try again — if it keeps happening, let support know.';
  }
  return cleaned;
}

/** Same cleanup, starting from an unknown catch-block value instead of a raw string. */
export function friendlyErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  return cleanErrorMessage(err instanceof Error ? err.message : fallback);
}
