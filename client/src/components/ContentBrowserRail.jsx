/**
 * Translate's unified content browser rail: Collections / Pages / Components
 * as expandable groups, each with leaves (a CMS collection, a Pages folder,
 * or "Components" as one leaf). Purely presentational -- Translate.jsx
 * computes every leaf's checkbox/count/active state and click handlers,
 * this just lays them out. Replaces the old CMS/Pages/Components
 * SegmentedControl + per-entity-type collection-pill picker with one
 * browser spanning all three, matching the "Sync Panel - Ledger" redesign.
 */
export default function ContentBrowserRail({ groups, dateFilter }) {
  return (
    <div className="flex w-[17rem] flex-none flex-col overflow-hidden rounded-lg border border-border bg-surface">
      {dateFilter && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-[11.5px]">
          <span className="whitespace-nowrap text-ink-faint">Updated after</span>
          <select
            value={dateFilter.value}
            onChange={(e) => dateFilter.onChange(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-xs font-medium outline-none"
          >
            {dateFilter.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex-1 overflow-auto p-1.5">
        {groups.map((g) => (
          <div key={g.id}>
            <button
              type="button"
              onClick={g.onToggle}
              className="flex w-full items-center gap-1.5 px-2 py-2 text-left text-[10.5px] font-bold uppercase tracking-wide text-ink-faint"
            >
              <span className="w-2.5 text-[9px]">{g.expanded ? "▾" : "▸"}</span>
              {g.label}
              <span className="opacity-60">{g.count}</span>
            </button>
            {g.expanded &&
              g.leaves.map((lf) => (
                <div
                  key={lf.key}
                  onClick={lf.onOpen}
                  className={
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-sunken " +
                    (lf.active ? "bg-accent-subtle" : "")
                  }
                >
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      lf.onCheck();
                    }}
                    className={
                      "flex h-4 w-4 flex-none items-center justify-center rounded border text-[10px] leading-none text-white " +
                      (lf.mark ? "border-accent bg-accent" : "border-border-strong bg-transparent")
                    }
                  >
                    {lf.mark}
                  </div>
                  <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{lf.label}</div>
                  {lf.filtered && (
                    <span className="flex-none rounded bg-accent-subtle px-1 py-0.5 font-mono text-[9px] font-semibold text-accent-text">
                      RULE
                    </span>
                  )}
                  <span className="flex-none font-mono text-[11px] text-ink-faint">{lf.count}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
