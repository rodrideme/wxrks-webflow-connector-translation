import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import api from "../services/api.js";
import SettingsAccount from "./settings/SettingsAccount.jsx";
import SettingsKeys from "./settings/SettingsKeys.jsx";
import SettingsWxrks from "./settings/SettingsWxrks.jsx";
import SettingsFieldExclusions from "./settings/SettingsFieldExclusions.jsx";
import SettingsComponentPropertyExclusions from "./settings/SettingsComponentPropertyExclusions.jsx";
import SettingsSlugHandling from "./settings/SettingsSlugHandling.jsx";
import SettingsLlm from "./settings/SettingsLlm.jsx";

const TABS = [
  { to: "account", label: "General" },
  { to: "slug-handling", label: "Slug handling" },
  { to: "llm", label: "LLM connectors" },
  { to: "wxrks", label: "wxrks connection" },
  { to: "fields", label: "Field exclusions" },
  { to: "component-properties", label: "Component properties" },
  { to: "keys", label: "Keys" },
];

function SettingsNav() {
  return (
    <nav className="w-44 flex-none">
      <div className="flex flex-col gap-0.5">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
              (isActive ? "bg-accent-subtle text-accent-text" : "text-ink-soft hover:text-ink")
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/**
 * App-level configuration, split into its own tabs (vertical nav on the
 * left) now that there are enough sections to make one long scrolling page
 * unwieldy: General (timezone, naming patterns, automation toggles,
 * source locale), Slug handling, LLM connectors, wxrks connection, Field
 * exclusions, and read-only env Keys. Org unit + target locales used to
 * live here too, but now that the wizard (Send to wxrks) always sends its
 * own explicit values for every one-time send and automation (see
 * SendToWxrksModal.jsx), General only shows the source locale read-only --
 * auto-detected from the connected Webflow site, not something to
 * configure manually.
 */
export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [webflowLocales, setWebflowLocales] = useState(null);
  const [error, setError] = useState(null);

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
  }

  // Saves only the given top-level settings fields (read from current draft
  // state) rather than the whole object -- each tab now has its own Save
  // button and shouldn't clobber another tab's unsaved draft edits.
  async function saveFields(fields) {
    const patch = {};
    fields.forEach((f) => (patch[f] = settings[f]));
    const updated = await api.updateSettings(patch);
    setSettings((prev) => ({ ...prev, ...updated }));
  }

  if (!settings) return <p className="text-sm text-ink-soft">Loading settings...</p>;

  return (
    <div>
      <h1 className="mb-6 text-[22px] font-semibold tracking-tight text-ink">Settings</h1>
      {error && <p className="mb-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}

      <div className="flex gap-10">
        <SettingsNav />
        <div className="min-w-0 max-w-2xl flex-1">
          <Routes>
            <Route index element={<Navigate to="account" replace />} />
            <Route
              path="account"
              element={
                <SettingsAccount settings={settings} markDirty={markDirty} webflowLocales={webflowLocales} saveFields={saveFields} />
              }
            />
            <Route
              path="slug-handling"
              element={<SettingsSlugHandling settings={settings} markDirty={markDirty} saveFields={saveFields} />}
            />
            <Route
              path="llm"
              element={<SettingsLlm llmConnected={settings.llmConnected} llmApiKeyMasked={settings.llmApiKeyMasked} onChange={loadSettings} />}
            />
            <Route
              path="wxrks"
              element={
                <SettingsWxrks
                  wxrksConnected={settings.wxrksConnected}
                  wxrksAccessKeyMasked={settings.wxrksAccessKeyMasked}
                  onChange={loadSettings}
                  settings={settings}
                  markDirty={markDirty}
                  saveFields={saveFields}
                />
              }
            />
            <Route path="fields" element={<SettingsFieldExclusions />} />
            <Route
              path="component-properties"
              element={<SettingsComponentPropertyExclusions settings={settings} markDirty={markDirty} />}
            />
            <Route path="keys" element={<SettingsKeys settings={settings} />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
