import StatusPill from "./components/StatusPill.jsx";

/**
 * Maps a Webflow item's per-locale sync status (server-computed in
 * routes/collections.js: "published" | "draft" | "missing") to the app's
 * fixed status-pill vocabulary. Kept separate from the pill vocabulary's
 * own "draft" variant (which means "not yet sent to wxrks") since
 * Webflow's "draft" here means something different (translated, but the
 * Webflow entry itself is unpublished) -- explicit labels avoid the two
 * meanings colliding under one word.
 */
export function localeStatusPill(status) {
  if (status === "published") return <StatusPill variant="success" label="Published" />;
  if (status === "draft") return <StatusPill variant="progress" label="Draft" />;
  if (status === "missing") return <StatusPill variant="draft" label="Missing" />;
  return <StatusPill variant="draft" label="—" />;
}
