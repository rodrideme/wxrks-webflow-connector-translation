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

// Compact "21 Jul 09:42" -- no year, no seconds, 24h -- for the Runs page's
// History tab, where the full formatDateTime() output was wide enough to
// wrap column values onto a second line.
export function formatCompactDateTime(iso, timezone) {
  if (!iso) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}
