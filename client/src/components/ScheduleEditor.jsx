const hintClass = "text-xs text-ink-faint";
const timeInputClass =
  "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

// Evenly spaces `n` times across a 24h day starting at midnight, e.g.
// n=2 -> ["00:00", "12:00"], n=4 -> ["00:00", "06:00", "12:00", "18:00"].
// Used as the starting point when the user changes the flush count -- each
// individual time stays editable afterward.
function computeEvenTimes(n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const totalMinutes = Math.round((i * 24 * 60) / n);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    times.push(`${hh}:${mm}`);
  }
  return times;
}

/**
 * Controlled editor for an automation's send schedule (times per day) --
 * extracted from the old singleton Auto Sync settings page so the same UI
 * can be embedded in NewAutomationModal for each individual automation.
 */
export default function ScheduleEditor({ flushTimes, onChange, timezone }) {
  function setFlushCount(n) {
    onChange(computeEvenTimes(Math.max(1, Math.min(24, n))));
  }

  function setFlushTimeAt(index, value) {
    onChange(flushTimes.map((t, i) => (i === index ? value : t)));
  }

  function removeFlushTimeAt(index) {
    onChange(flushTimes.filter((_, i) => i !== index));
  }

  function addFlushTime() {
    onChange([...flushTimes, "00:00"].sort());
  }

  return (
    <div>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink-soft">
        Number of sends per day:
        <input
          type="number"
          min={1}
          max={24}
          value={flushTimes.length}
          onChange={(e) => setFlushCount(Number(e.target.value) || 1)}
          className="w-24 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </label>
      <p className={`mt-1 ${hintClass}`}>
        Changing this evenly spaces the times below across the day -- edit any individual time afterward for a
        different schedule. All times are in {timezone} (Settings page).
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {flushTimes.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="time" value={t} onChange={(e) => setFlushTimeAt(i, e.target.value)} className={timeInputClass} />
            <button
              type="button"
              onClick={() => removeFlushTimeAt(i)}
              disabled={flushTimes.length <= 1}
              className="text-xs text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" onClick={addFlushTime} className="self-start text-xs font-medium text-accent-text hover:underline">
          + Add send time
        </button>
      </div>
    </div>
  );
}
