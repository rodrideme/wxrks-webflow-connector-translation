/**
 * Small mono-set tag for a locale code (or any short data token). Reused
 * as a running motif anywhere a locale appears -- Dashboard project rows,
 * Sync Panel headers, History summaries.
 */
export default function Chip({ children, error = false }) {
  return (
    <span
      className={
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums " +
        (error ? "bg-status-error-bg text-status-error-fg" : "bg-surface-sunken text-ink-soft")
      }
    >
      {children}
    </span>
  );
}
