import StatusPill from "./StatusPill.jsx";
import ProgressBar from "./ProgressBar.jsx";

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-5 py-2 text-[13.5px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint";

/**
 * Persistent, full-width sticky bottom bar for Translate -- the redesign's
 * one launch surface, replacing the earlier sidebar-only pattern (see
 * git history: that was folded into SyncSidebar two sessions ago, then
 * explicitly reversed by this redesign back into a page-wide bar). Clicking
 * "Translate" opens SendToWxrksModal (confirmation lives in that modal's
 * Review step, not a separate bar phase); after the modal kicks off one or
 * more background jobs, this bar polls and shows real progress + Cancel
 * (large sends -- a whole collection, "All content" -- can mean hundreds of
 * real wxrks API calls and take minutes, so a fire-and-forget "Sending…"
 * spinner isn't enough).
 */
export default function TranslateActionBar({ mode, selCount, selWords, targetCount, ruleBased, allTotalItems, allTotalWords, phase, progress, result, onOpenSend, onReset, onCancel }) {
  const plural = (n) => `item${n === 1 ? "" : "s"}`;

  return (
    <div className="sticky bottom-0 z-10 -mx-8 mt-auto border-t border-border bg-surface px-8 py-3.5 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]">
      {phase === "running" && progress && (
        <div className="flex items-center gap-4">
          <StatusPill variant="progress" label={`Creating ${progress.jobCount > 1 ? `${progress.jobCount} projects` : "project"}…`} />
          <span className="flex-1">
            <ProgressBar value={progress.processed} max={progress.total} label={`${progress.processed} / ${progress.total} processed`} />
          </span>
          <button onClick={onCancel} className={btnGhost}>
            Cancel
          </button>
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

      {phase === "idle" && mode === "all" && (
        <div className="flex items-center gap-4">
          <span className="text-[13.5px]">
            <b className="font-semibold">All content</b> · {allTotalItems} items · ~{allTotalWords?.toLocaleString()} words ·{" "}
            {targetCount} locales
          </span>
          <button onClick={onOpenSend} className={btnPrimary + " ml-auto"}>
            Translate all — {allTotalItems} items
          </button>
        </div>
      )}

      {phase === "idle" && mode === "specific" && (
        <div className="flex items-center gap-4">
          <span className={"text-[13.5px] " + (selCount > 0 ? "text-ink" : "text-ink-faint")}>
            <b className="font-semibold">
              {selCount} {plural(selCount)}
            </b>{" "}
            · ~{selWords?.toLocaleString()} words · {targetCount} locales
          </span>
          {selCount > 0 && (
            <span className={"flex items-center gap-1.5 text-xs font-semibold " + (ruleBased ? "text-status-success-fg" : "text-status-progress-fg")}>
              <span className={"h-1.5 w-1.5 rounded-full " + (ruleBased ? "bg-status-success-dot" : "bg-status-progress-dot")} />
              {ruleBased ? "Rule-based — can run on a schedule" : "Individual selection — one-time send only"}
            </span>
          )}
          <button onClick={onOpenSend} disabled={selCount === 0} className={btnPrimary + " ml-auto"}>
            Translate — {selCount} {plural(selCount)}
          </button>
        </div>
      )}
    </div>
  );
}
