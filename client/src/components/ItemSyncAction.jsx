import StatusPill from "./StatusPill.jsx";

const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint";

/**
 * Item Sync's selection → launch flow, rendered as SyncSidebar children
 * (stacked full-width, matching Bulk Sync's Preview/Launch buttons) instead
 * of the old standalone sticky bottom bar. Phases: idle (Translate button),
 * confirm (one-tap safety check before the real POST), running
 * (indeterminate -- item sync is a single synchronous request), done
 * (result recap + reset). `entityLabel` is the singular noun ("item"/
 * "page"/"component") -- pluralized here based on count.
 */
export default function ItemSyncAction({
  phase,
  entityLabel,
  selCount,
  selWords,
  onLaunch,
  onConfirm,
  onCancel,
  onReset,
  result,
}) {
  const canLaunch = selCount > 0 && phase === "idle";
  const plural = (n) => `${entityLabel}${n === 1 ? "" : "s"}`;

  return (
    <>
      {phase === "idle" && (
        <button onClick={onLaunch} disabled={!canLaunch} className={btnPrimary + " w-full"}>
          Translate — {selCount} {plural(selCount)}
        </button>
      )}

      {phase === "confirm" && (
        <>
          <div className="text-[12.5px] text-ink-soft">
            Send {selCount} {plural(selCount)}
            {selWords > 0 ? ` (~${selWords.toLocaleString()} words)` : ""} to wxrks as one project? This starts
            translation immediately.
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel} className={btnGhost + " flex-1"}>
              Cancel
            </button>
            <button onClick={onConfirm} className={btnPrimary + " flex-1"}>
              Confirm
            </button>
          </div>
        </>
      )}

      {phase === "running" && <StatusPill variant="progress" label={`Translating ${selCount} ${plural(selCount)}…`} />}

      {phase === "done" && result && (
        <>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <StatusPill
              variant={result.errors > 0 ? "error" : "success"}
              label={result.errors > 0 ? `${result.errors} error(s)` : "Sent"}
            />
            {result.itemsSynced} {plural(result.itemsSynced)}
          </div>
          <div className="font-mono text-[11px] text-ink-faint">{result.wxrksProjectUUID}</div>
          <button onClick={onReset} className={btnGhost + " w-full"}>
            Start another
          </button>
        </>
      )}
    </>
  );
}
