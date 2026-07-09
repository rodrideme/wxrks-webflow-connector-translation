import { useEffect, useState } from "react";
import api from "../services/api.js";
import SettingsAccount from "./settings/SettingsAccount.jsx";
import SettingsKeys from "./settings/SettingsKeys.jsx";
import SettingsWxrks from "./settings/SettingsWxrks.jsx";
import SettingsFieldExclusions from "./settings/SettingsFieldExclusions.jsx";

/**
 * App-level configuration: timezone, naming patterns, automation toggles,
 * wxrks connection, per-field translation exclusions, and env keys. Org
 * unit + target locales used to live here too, but now that the wizard
 * (Send to wxrks) always sends its own explicit values for every one-time
 * send and automation (see SendToWxrksModal.jsx), this page only shows the
 * source locale read-only -- auto-detected from the connected Webflow
 * site, not something to configure manually. Per-collection SYNC scope
 * (enable/disable a whole collection) moved out too: the Dashboard's
 * backlog widget now scans every collection and derives locales from
 * Webflow directly instead of from settings (see routes/collections.js's
 * backlogHandler). Per-FIELD exclusions (SettingsFieldExclusions below)
 * stayed -- that's a different, still-needed concern with no other UI
 * surface in the app.
 */
export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [webflowLocales, setWebflowLocales] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function loadSettings() {
    return Promise.all([api.getSettings(), api.getWebflowLocales().catch(() => null)])
      .then(([settingsRes, localesRes]) => {
        setWebflowLocales(localesRes);

        let next = { ...settingsRes };
        if (localesRes?.primary?.tag && next.sourceLocale !== localesRes.primary.tag) {
          next.sourceLocale = localesRes.primary.tag;
        }
        setSettings(next);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadSettings();
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
        sourceLocale: settings.sourceLocale,
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
        <SettingsAccount settings={settings} markDirty={markDirty} webflowLocales={webflowLocales} />

        <div className="mt-8">
          <SettingsWxrks
            wxrksConnected={settings.wxrksConnected}
            wxrksAccessKeyMasked={settings.wxrksAccessKeyMasked}
            onChange={loadSettings}
          />
        </div>

        <div className="mt-8">
          <SettingsFieldExclusions />
        </div>

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
