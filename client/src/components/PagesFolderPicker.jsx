import { useEffect, useState } from "react";
import api from "../services/api.js";

/**
 * Controlled folder checkbox picker for a Pages automation's scope. Folders
 * aren't returned by Webflow's page-listing endpoint at all (confirmed
 * live) -- server/services/webflow.js's listPageFolders() resolves them
 * indirectly, one call per distinct folder id referenced by some page's
 * parentId. `"__root__"` (NO_FOLDER_ID server-side) represents top-level
 * pages with no folder, shown here like a normal selectable entry.
 */
export default function PagesFolderPicker({ value, onChange }) {
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getPageFolders().then((res) => setFolders(res.folders || [])).catch((err) => setError(err.message));
  }, []);

  function toggleFolder(folderId) {
    const next = value.includes(folderId) ? value.filter((id) => id !== folderId) : [...value, folderId];
    onChange(next);
  }

  if (error) return <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>;
  if (!folders) return <p className="text-sm text-ink-faint">Loading folders...</p>;
  if (folders.length === 0) return <p className="text-sm text-ink-faint">No folders found on this site.</p>;

  return (
    <div className="flex flex-wrap gap-2">
      {folders.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => toggleFolder(f.id)}
          className={
            "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors " +
            (value.includes(f.id)
              ? "border-ink bg-ink text-canvas"
              : "border-border-strong bg-surface text-ink-soft hover:text-ink")
          }
        >
          {f.title}
          <span className="font-mono text-[11px] font-medium opacity-70 tabular-nums">{f.pageCount}</span>
        </button>
      ))}
    </div>
  );
}
