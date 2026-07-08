import { useEffect, useState } from "react";
import api from "../services/api.js";
import SettingsAccount from "./settings/SettingsAccount.jsx";
import SettingsKeys from "./settings/SettingsKeys.jsx";

/**
 * App-level configuration: timezone, work-unit naming patterns, autoApprove/
 * autoPublish toggles, and env keys. Distinct from Templates.jsx, which
 * holds "what gets translated" (org unit, locales, collections/pages/
 * components for manual Select & Send) and from the Automation page, which
 * holds each automation's own content scope + schedule.
 */
export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((err) => setError(err.message));
  }, []);

  function markDirty(patch) {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateSettings({
        timezone: settings.timezone,
        workUnitNamePattern: settings.workUnitNamePattern,
        pagesWorkUnitNamePattern: settings.pagesWorkUnitNamePattern,
        componentsWorkUnitNamePattern: settings.componentsWorkUnitNamePattern,
        autoApprove: settings.autoApprove,
        autoPublish: settings.autoPublish,
      });
      setSettings((prev) => ({ ...prev, ...updated }));
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p className="text-sm text-ink-soft">Loading settings...</p>;

  return (
    <div>
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">Settings</h1>

      <div className="max-w-2xl">
        <SettingsAccount settings={settings} markDirty={markDirty} />

        {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}
        {saved && <p className="mt-4 text-sm font-medium text-status-success-fg">Settings saved.</p>}

        <button
          onClick={save}
          disabled={saving}
          className="mt-4 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>

        <div className="mt-8">
          <SettingsKeys settings={settings} />
        </div>
      </div>
    </div>
  );
}
