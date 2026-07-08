import StatusPill from "./components/StatusPill.jsx";

/**
 * Maps a per-locale delivery status (server-computed in
 * routes/collections.js / syncPages.js / syncComponents.js:
 * "synced" | "stale" | "failed" | "new", derived from project_mappings'
 * updates[] delivery log compared against the source's own last-updated
 * time) to the app's fixed status-pill vocabulary.
 */
export function localeStatusPill(status) {
  if (status === "synced") return <StatusPill variant="success" label="Synced" />;
  if (status === "stale") return <StatusPill variant="progress" label="Stale" />;
  if (status === "failed") return <StatusPill variant="error" label="Failed" />;
  if (status === "new") return <StatusPill variant="draft" label="New" />;
  return <StatusPill variant="draft" label="—" />;
}
