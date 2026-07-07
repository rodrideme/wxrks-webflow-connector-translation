import { useState } from "react";
import api from "../../services/api.js";

const cardClass = "mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm";
const hintClass = "text-xs text-slate-500";

const WEBHOOK_STATUS_STYLES = {
  active: "bg-green-100 text-green-800",
  not_registered: "bg-slate-100 text-slate-600",
  deactivated: "bg-red-100 text-red-800",
  error: "bg-red-100 text-red-800",
};

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
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
    <>
      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Auto Sync</h2>
        <p className={`mb-4 ${hintClass}`}>
          Automatically translate content when it's published in Webflow, based on the collections and
          conditions configured below. A third mode alongside Full Sync and Item Sync -- passive, not manually
          triggered.
        </p>

        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={autoSync.enabled}
            onChange={(e) => markAutoSyncDirty({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
          />
          Enable Auto Sync
        </label>

        <label className="mt-4 flex flex-col gap-1 text-sm font-medium text-slate-700">
          Number of flushes per day:
          <input
            type="number"
            min={1}
            max={24}
            value={autoSync.flushTimes.length}
            onChange={(e) => setFlushCount(Number(e.target.value) || 1)}
            className="w-24 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </label>
        <p className={`mt-1 ${hintClass}`}>
          Changing this evenly spaces the times below across the day -- edit any individual time afterward if
          you want a different schedule. All times are UTC.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {autoSync.flushTimes.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="time"
                value={t}
                onChange={(e) => setFlushTimeAt(i, e.target.value)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <button
                type="button"
                onClick={() => removeFlushTimeAt(i)}
                disabled={autoSync.flushTimes.length <= 1}
                className="text-xs text-red-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={addFlushTime} className="self-start text-xs font-medium text-brand-600 hover:underline">
            + Add flush time
          </button>
        </div>

        <p className={`mt-3 ${hintClass}`}>
          Qualifying publishes are batched and sent to wxrks together at these times, instead of one wxrks
          project per publish. Use "Flush now" on the Sync Panel's Auto Sync tab to send the current queue
          immediately without waiting.
        </p>
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Webflow webhook</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              WEBHOOK_STATUS_STYLES[autoSync.webhook.status] || "bg-slate-100 text-slate-600"
            }`}
          >
            {autoSync.webhook.status.replace("_", " ")}
          </span>
          {autoSync.webhook.status !== "active" && autoSync.enabled && (
            <button
              onClick={reregisterWebhook}
              disabled={reregistering}
              className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {reregistering ? "Registering..." : "Re-register webhook"}
            </button>
          )}
        </div>
        <table className="mt-3 w-full text-left text-sm">
          <tbody className="divide-y divide-slate-100">
            <tr>
              <td className="py-1.5 pr-4 font-medium text-slate-500">Registered</td>
              <td className="py-1.5 text-slate-800">{formatDate(autoSync.webhook.registeredAt)}</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-slate-500">Last event received</td>
              <td className="py-1.5 text-slate-800">{formatDate(autoSync.webhook.lastEventAt)}</td>
            </tr>
            {autoSync.webhook.lastError && (
              <tr>
                <td className="py-1.5 pr-4 font-medium text-slate-500">Last error</td>
                <td className="py-1.5 text-red-600">{autoSync.webhook.lastError}</td>
              </tr>
            )}
          </tbody>
        </table>
        {reregisterError && <p className="mt-2 text-sm font-medium text-red-600">{reregisterError}</p>}
        <p className={`mt-3 ${hintClass}`}>
          Level 2 (which collections) and Level 3 (per-field conditions) are configured on the Collections page,
          next to each collection's existing sync settings.
        </p>
      </section>
    </>
  );
}
