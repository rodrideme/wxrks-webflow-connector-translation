import { useEffect, useRef, useState } from "react";

/**
 * Value picker for a Reference/MultiReference filter row (e.g. "Author is
 * ...", "Tags is ..."). `options` are the LINKED collection's own items
 * (already loaded via the same loadCollectionItems used to browse any
 * collection directly -- see Translate.jsx), each `{id, name}`. Always
 * multi-select, even for a single-value Reference field: one filter row
 * matching ANY of several picked options is the only way to express
 * "Tag A or Tag B" at all, since separate filter rows are ANDed together.
 */
export default function ReferenceFilterValue({ options, selectedIds, onChange, loading, error, onRetry }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selected = options.filter((o) => selectedIds.includes(o.id));
  const buttonLabel = loading
    ? "Loading options…"
    : error
    ? "Couldn't load options"
    : selected.length === 0
    ? "Select…"
    : selected.length === 1
    ? selected[0].name
    : `${selected.length} selected`;

  const filteredOptions = options.filter((o) => o.name?.toLowerCase().includes(search.toLowerCase()));

  function toggle(id) {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((i) => i !== id));
    else onChange([...selectedIds, id]);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
        className="min-w-[9rem] max-w-[14rem] truncate rounded-md border border-border-strong bg-surface px-2 py-1 text-left text-xs disabled:cursor-not-allowed disabled:opacity-60"
      >
        {buttonLabel}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-surface p-2 shadow-card">
          {error ? (
            <div className="flex flex-col items-start gap-1.5 p-1.5">
              <p className="text-xs text-status-error-fg">Couldn't load options: {error}</p>
              <button type="button" onClick={onRetry} className="text-xs font-semibold text-accent-text hover:underline">
                Retry
              </button>
            </div>
          ) : (
            <>
              {options.length > 6 && (
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  autoFocus
                  className="mb-1.5 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-xs"
                />
              )}
              <div className="max-h-48 overflow-auto">
                {filteredOptions.length === 0 ? (
                  <p className="p-1.5 text-xs text-ink-faint">{options.length === 0 ? "No options" : "No matches"}</p>
                ) : (
                  filteredOptions.map((o) => (
                    <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-sunken">
                      <input type="checkbox" checked={selectedIds.includes(o.id)} onChange={() => toggle(o.id)} />
                      <span className="truncate">{o.name}</span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
