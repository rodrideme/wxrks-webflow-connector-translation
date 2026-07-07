/**
 * One progress component, reused for Bulk Sync's launch bar, Auto Sync's
 * pending queue, and any other "N of M processed" state -- instead of
 * each screen inventing its own bar.
 */
export default function ProgressBar({ value, max, label }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
      {label !== null && (
        <div className="mt-1.5 flex justify-between text-xs text-ink-soft">
          <span>{label}</span>
          <span className="font-mono font-semibold tabular-nums text-ink">{pct}%</span>
        </div>
      )}
    </div>
  );
}
