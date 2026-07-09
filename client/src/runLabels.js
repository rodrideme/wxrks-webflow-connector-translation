// Shared display-label helpers for a sync run/automation, used by both
// Dashboard.jsx (recent runs / running automations summary) and Runs.jsx
// (full history / automations list) -- previously duplicated verbatim in
// both files.

export function modeLabel(mode, automationName) {
  if (mode === "pages-bulk") return "Pages · Bulk Sync";
  if (mode === "pages-item") return "Pages · Item Sync";
  if (mode === "components-bulk") return "Components · Bulk Sync";
  if (mode === "components-item") return "Components · Item Sync";
  if (mode === "bulk") return "Bulk Sync";
  if (mode === "item") return "Item Sync";
  if (mode === "auto") return "Auto Sync";
  if (mode === "automation") return automationName ? `Automation · ${automationName}` : "Automation";
  return mode;
}

export function cadenceLabel(cadence) {
  if (!cadence) return "—";
  if (cadence.kind === "hourly") return `Hourly · every ${cadence.everyHours}h from ${cadence.startTime}`;
  if (cadence.kind === "weekly") return `Weekly · ${cadence.weekday} ${cadence.time}`;
  return `Daily · ${cadence.time}`;
}
