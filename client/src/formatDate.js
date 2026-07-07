// Formats dates using the app's configured timezone (settings.timezone)
// rather than each browser's own local zone, so every viewer sees the same
// wall-clock time for a given instant. Falls back to the browser's local
// zone if no timezone is passed (e.g. before settings have loaded).

export function formatDateTime(iso, timezone) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined);
}

export function formatDateOnly(iso, timezone) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, timezone ? { timeZone: timezone } : undefined);
}
