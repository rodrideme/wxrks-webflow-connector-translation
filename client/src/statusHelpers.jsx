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

/**
 * Webflow's own real publish state (see leafHelpers.js's
 * computeWebflowStatus) -- distinct from localeStatusPill above, which is
 * this app's own translation-sync tracking. null means there's simply no
 * signal to go on (e.g. a component, which carries no date/status field at
 * all) -- shown as a plain dash rather than a pill, since it isn't really
 * a "draft"/"unknown" state, just data Webflow doesn't expose here.
 */
export function webflowStatusPill(status) {
  if (status === "published") return <StatusPill variant="success" label="Published" />;
  if (status === "changed") return <StatusPill variant="progress" label="Changed" />;
  if (status === "draft") return <StatusPill variant="draft" label="Draft" />;
  if (status === "archived") return <StatusPill variant="draft" label="Archived" />;
  return <span className="text-ink-faint">—</span>;
}
