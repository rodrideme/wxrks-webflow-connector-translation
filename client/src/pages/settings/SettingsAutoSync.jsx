import { useState } from "react";
import api from "../../services/api.js";
import { formatDateTime } from "../../formatDate.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";
import StatusPill from "../../components/StatusPill.jsx";

const hintClass = "text-xs text-ink-faint";
const btnGhost =
  "rounded-md border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-faint disabled:opacity-50";
const timeInputClass =
  "rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

function webhookPill(status) {
  if (status === "active") return <StatusPill variant="success" label="Active" />;
  if (status === "not_registered") return <StatusPill variant="draft" label="Not registered" />;
  return <StatusPill variant="error" label={status.replace("_", " ")} />;
}

// Evenly spaces `n` times across a 24h UTC day starting at midnight, e.g.
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

export default function SettingsAutoSync({ settings, markDirty }) {
  const { autoSync } = settings;
  const [reregistering, setReregistering] = useState(false);
  const [reregisterError, setReregisterError] = useState(null);

  function markAutoSyncDirty(patch) {
    markDirty({ autoSync: { ...autoSync, ...patch } });
  }

  function setFlushCount(n) {
    markAutoSyncDirty({ flushTimes: computeEvenTimes(Math.max(1, Math.min(24, n))) });
  }

  function setFlushTimeAt(index, value) {
    const flushTimes = autoSync.flushTimes.map((t, i) => (i === index ? value : t));
    markAutoSyncDirty({ flushTimes });
  }

  function removeFlushTimeAt(index) {
    markAutoSyncDirty({ flushTimes: autoSync.flushTimes.filter((_, i) => i !== index) });
  }

  function addFlushTime() {
    markAutoSyncDirty({ flushTimes: [...autoSync.flushTimes, "00:00"].sort() });
  }

  async function reregisterWebhook() {
    setReregistering(true);
    setReregisterError(null);
    try {
      await api.reregisterAutoSyncWebhook();
      window.location.reload(); // simplest way to pick up the fresh webhook state
    } catch (err) {
      setReregisterError(err.message);
    } finally {
      setReregistering(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Auto Sync</h2>
        <p className={`mb-4 ${hintClass}`}>
          Automatically translate content when it's published in Webflow, based on the collections and
          conditions configured below. A third mode alongside Bulk Sync and Item Sync -- passive, not manually
          triggered.
        </p>

        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <Toggle checked={autoSync.enabled} onChange={(e) => markAutoSyncDirty({ enabled: e.target.checked })} label="Enable Auto Sync" />
          Enable Auto Sync
        </label>

        <label className="mt-4 flex flex-col gap-1 text-sm font-medium text-ink-soft">
          Number of flushes per day:
          <input
            type="number"
            min={1}
            max={24}
            value={autoSync.flushTimes.length}
            onChange={(e) => setFlushCount(Number(e.target.value) || 1)}
            className="w-24 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
        <p className={`mt-1 ${hintClass}`}>
          Changing this evenly spaces the times below across the day -- edit any individual time afterward if
          you want a different schedule. All times are in {settings.timezone} (Settings page).
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {autoSync.flushTimes.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input type="time" value={t} onChange={(e) => setFlushTimeAt(i, e.target.value)} className={timeInputClass} />
              <button
                type="button"
                onClick={() => removeFlushTimeAt(i)}
                disabled={autoSync.flushTimes.length <= 1}
                className="text-xs text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addFlushTime} className="self-start text-xs font-medium text-accent-text hover:underline">
            + Add flush time
          </button>
        </div>

        <p className={`mt-3 ${hintClass}`}>
          Qualifying publishes are batched and sent to wxrks together at these times, instead of one wxrks
          project per publish. Use "Flush now" on the Sync Panel's Auto Sync tab to send the current queue
          immediately without waiting.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Webflow webhook</h2>
        <div className="flex items-center gap-2">
          {webhookPill(autoSync.webhook.status)}
          {autoSync.webhook.status !== "active" && autoSync.enabled && (
            <button onClick={reregisterWebhook} disabled={reregistering} className={btnGhost}>
              {reregistering ? "Registering..." : "Re-register webhook"}
            </button>
          )}
        </div>
        <table className="mt-3 w-full text-left text-sm">
          <tbody className="divide-y divide-border">
            <tr>
              <td className="py-1.5 pr-4 font-medium text-ink-faint">Registered</td>
              <td className="py-1.5 text-ink">{formatDateTime(autoSync.webhook.registeredAt, settings.timezone)}</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-ink-faint">Last event received</td>
              <td className="py-1.5 text-ink">{formatDateTime(autoSync.webhook.lastEventAt, settings.timezone)}</td>
            </tr>
            {autoSync.webhook.lastError && (
              <tr>
                <td className="py-1.5 pr-4 font-medium text-ink-faint">Last error</td>
                <td className="py-1.5 text-status-error-fg">{autoSync.webhook.lastError}</td>
              </tr>
            )}
          </tbody>
        </table>
        {reregisterError && <p className="mt-2 text-sm font-medium text-status-error-fg">{reregisterError}</p>}
        <p className={`mt-3 ${hintClass}`}>
          Level 2 (which collections) and Level 3 (per-field conditions) are configured on the Collections page,
          next to each collection's existing sync settings.
        </p>
      </Card>
    </div>
  );
}
