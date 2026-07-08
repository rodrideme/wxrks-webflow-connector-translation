import StatusPill from "./StatusPill.jsx";

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint";

/**
 * Sticky bottom bar for Item Sync's selection → launch flow (adopted from
 * the Ledger reference), replacing an inline "Launch" button above the
 * table. Phases: idle (selection summary + Launch), confirm (one-tap
 * safety check before the real POST -- new; we didn't have this before),
 * running (item sync is a single synchronous request, so this shows an
 * indeterminate "sending" state rather than a numeric progress bar), done
 * (result recap + reset). `entityLabel` is the singular noun ("item"/
 * "page"/"component") -- pluralized here based on count so the copy
 * always reads grammatically.
 */
export default function SyncActionBar({
  phase,
  entityLabel,
  selCount,
  selWords,
  targetCount,
  onLaunch,
  onConfirm,
  onCancel,
  onReset,
  result,
}) {
  const canLaunch = selCount > 0 && phase === "idle";
  const plural = (n) => `${entityLabel}${n === 1 ? "" : "s"}`;

  return (
    <div className="sticky bottom-0 z-10 -mx-8 border-t border-border bg-surface px-8 py-3.5 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
      {phase === "idle" && (
        <div className="flex items-center gap-4">
          <span className="text-[13.5px] text-ink">
            <b className="font-semibold">{selCount} selected</b> · ~
            <span className="font-mono tabular-nums">{selWords?.toLocaleString()}</span> words ·{" "}
            {targetCount} locale{targetCount === 1 ? "" : "s"}
          </span>
          <button onClick={onLaunch} disabled={!canLaunch} className={btnPrimary + " ml-auto"}>
            Launch — {selCount} {plural(selCount)}
          </button>
        </div>
      )}

      {phase === "confirm" && (
        <div className="flex items-center gap-4">
          <div>
            <div className="text-[13.5px] font-semibold text-ink">
              Send {selCount} {plural(selCount)} (~{selWords?.toLocaleString()} words) to wxrks as one project?
            </div>
            <div className="text-[12.5px] text-ink-faint">This starts translation immediately.</div>
          </div>
          <div className="ml-auto flex gap-2.5">
            <button onClick={onCancel} className={btnGhost}>
              Cancel
            </button>
            <button onClick={onConfirm} className={btnPrimary}>
              Confirm — translate now
            </button>
          </div>
        </div>
      )}

      {phase === "running" && (
        <div className="flex items-center gap-3">
          <StatusPill variant="progress" label={`Sending ${selCount} ${plural(selCount)}…`} />
        </div>
      )}

      {phase === "done" && result && (
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
              <StatusPill variant={result.errors > 0 ? "error" : "success"} label={result.errors > 0 ? `${result.errors} error(s)` : "Sent"} />
              {result.itemsSynced} {plural(result.itemsSynced)} sent
            </div>
            <div className="mt-0.5 font-mono text-[11.5px] text-ink-faint">{result.wxrksProjectUUID}</div>
          </div>
          <button onClick={onReset} className={btnGhost + " ml-auto"}>
            Start another
          </button>
        </div>
      )}
    </div>
  );
}
