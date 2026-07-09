import { useEffect, useState } from "react";
import api from "../services/api.js";
import SettingsAccount from "./settings/SettingsAccount.jsx";
import SettingsKeys from "./settings/SettingsKeys.jsx";
import SettingsGeneral from "./settings/SettingsGeneral.jsx";
import SettingsCollections from "./settings/SettingsCollections.jsx";

function baseLang(code) {
  return code.toLowerCase().replace("_", "-").split("-")[0];
}

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "translation", label: "Translation" },
  { id: "collections", label: "Collections" },
];

/**
 * All persistent account-level configuration: timezone, naming patterns,
 * automation toggles, wxrks org unit + locales, and which CMS collections
 * are in scope for the Dashboard's backlog widget. The wizard (Send to
 * wxrks) can override org unit/target locales for a single send or
 * automation, but this page is where the standing defaults live and the
 * only place that can change them.
 */
export default function Settings() {
  const [section, setSection] = useState("account");
  const [settings, setSettings] = useState(null);
  const [orgUnits, setOrgUnits] = useState([]);
  const [webflowLocales, setWebflowLocales] = useState(null);
  const [collections, setCollections] = useState([]);
  const [orgUnitResources, setOrgUnitResources] = useState(null);
  const [orgUnitResourcesLoading, setOrgUnitResourcesLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getSettings(),
      api.getOrgUnits().catch(() => ({ orgUnits: [] })),
      api.getWebflowLocales().catch(() => null),
      api.getCollections().catch(() => ({ collections: [] })),
    ])
      .then(([settingsRes, orgUnitsRes, localesRes, collectionsRes]) => {
        setOrgUnits(orgUnitsRes.orgUnits || []);
        setWebflowLocales(localesRes);
        setCollections(collectionsRes.collections || []);

        let next = { ...settingsRes };
        if (localesRes?.primary?.tag && next.sourceLocale !== localesRes.primary.tag) {
          next.sourceLocale = localesRes.primary.tag;
        }
        setSettings(next);
        if (next.orgUnitUUID) loadOrgUnitResources(next.orgUnitUUID);
      })
      .catch((err) => setError(err.message));
  }, []);

  function loadOrgUnitResources(orgUnitUUID) {
    setOrgUnitResourcesLoading(true);
    api
      .getOrgUnitResources(orgUnitUUID)
      .then(setOrgUnitResources)
      .catch(() => setOrgUnitResources(null))
      .finally(() => setOrgUnitResourcesLoading(false));
  }

  function markDirty(patch) {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }

  function selectOrgUnit(orgUnitUUID) {
    const orgUnit = orgUnits.find((o) => o.uuid === orgUnitUUID);
    const patch = { orgUnitUUID };

    // Re-suggest target locales to match the newly selected org unit's
    // configured languages every time the org unit changes.
    if (orgUnit && webflowLocales) {
      const orgBaseLangs = new Set(orgUnit.targetLanguages.map(baseLang));
      const suggested = webflowLocales.secondary
        .filter((l) => orgBaseLangs.has(baseLang(l.tag)))
        .map((l) => l.tag);
      patch.targetLocales = suggested;
    }

    markDirty(patch);
    setOrgUnitResources(null);
    if (orgUnitUUID) loadOrgUnitResources(orgUnitUUID);
  }

  function toggleTargetLocale(locale) {
    const targetLocales = settings.targetLocales.includes(locale)
      ? settings.targetLocales.filter((l) => l !== locale)
      : [...settings.targetLocales, locale];
    markDirty({ targetLocales });
  }

  function checkAllTargetLocales() {
    markDirty({ targetLocales: (webflowLocales?.secondary || []).map((l) => l.tag) });
  }

  function uncheckAllTargetLocales() {
    markDirty({ targetLocales: [] });
  }

  function toggleCollection(collectionId) {
    if (settings.allCollectionsEnabled) {
      // Materialize: everything was implicitly enabled -- switch to an
      // explicit list of everything except the one just unchecked.
      const allIds = collections.map((c) => c.id);
      markDirty({
        allCollectionsEnabled: false,
        enabledCollectionIds: allIds.filter((id) => id !== collectionId),
      });
      return;
    }
    const enabledCollectionIds = settings.enabledCollectionIds.includes(collectionId)
      ? settings.enabledCollectionIds.filter((id) => id !== collectionId)
      : [...settings.enabledCollectionIds, collectionId];
    markDirty({ enabledCollectionIds });
  }

  function isCollectionEnabled(collectionId) {
    return settings.allCollectionsEnabled || settings.enabledCollectionIds.includes(collectionId);
  }

  function checkAllCollections() {
    markDirty({ allCollectionsEnabled: true, enabledCollectionIds: [] });
  }

  function uncheckAllCollections() {
    markDirty({ allCollectionsEnabled: false, enabledCollectionIds: [] });
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
        targetLocales: settings.targetLocales,
        orgUnitUUID: settings.orgUnitUUID,
        allCollectionsEnabled: settings.allCollectionsEnabled,
        enabledCollectionIds: settings.enabledCollectionIds,
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

      <div className="flex items-start gap-8">
        <nav className="flex w-40 shrink-0 flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={
                "rounded-md px-3 py-2 text-left text-sm font-medium transition-colors " +
                (section === s.id ? "bg-accent-subtle text-accent-text" : "text-ink-soft hover:text-ink")
              }
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 max-w-2xl">
          {section === "account" && (
            <>
              <SettingsAccount settings={settings} markDirty={markDirty} />
              <div className="mt-8">
                <SettingsKeys settings={settings} />
              </div>
            </>
          )}

          {section === "translation" && (
            <SettingsGeneral
              settings={settings}
              orgUnits={orgUnits}
              webflowLocales={webflowLocales}
              orgUnitResources={orgUnitResources}
              orgUnitResourcesLoading={orgUnitResourcesLoading}
              selectOrgUnit={selectOrgUnit}
              toggleTargetLocale={toggleTargetLocale}
              checkAllTargetLocales={checkAllTargetLocales}
              uncheckAllTargetLocales={uncheckAllTargetLocales}
            />
          )}

          {section === "collections" && (
            <SettingsCollections
              collections={collections}
              isCollectionEnabled={isCollectionEnabled}
              toggleCollection={toggleCollection}
              checkAllCollections={checkAllCollections}
              uncheckAllCollections={uncheckAllCollections}
              timezone={settings.timezone}
            />
          )}

          {error && <p className="mt-4 text-sm font-medium text-status-error-fg">Error: {error}</p>}
          {saved && <p className="mt-4 text-sm font-medium text-status-success-fg">Settings saved.</p>}

          <button
            onClick={save}
            disabled={saving}
            className="mt-4 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
