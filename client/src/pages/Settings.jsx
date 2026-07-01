import { useEffect, useState } from "react";
import api from "../services/api.js";
import SettingsGeneral from "./settings/SettingsGeneral.jsx";
import SettingsCollections from "./settings/SettingsCollections.jsx";
import SettingsKeys from "./settings/SettingsKeys.jsx";

function baseLang(code) {
  return code.toLowerCase().replace("_", "-").split("-")[0];
}

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "collections", label: "Collections" },
  { id: "keys", label: "Keys" },
];

export default function Settings() {
  const [section, setSection] = useState("general");
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
        sourceLocale: settings.sourceLocale,
        targetLocales: settings.targetLocales,
        autoPublish: settings.autoPublish,
        autoApprove: settings.autoApprove,
        orgUnitUUID: settings.orgUnitUUID,
        allCollectionsEnabled: settings.allCollectionsEnabled,
        enabledCollectionIds: settings.enabledCollectionIds,
        workUnitNamePattern: settings.workUnitNamePattern,
      });
      setSettings((prev) => ({ ...prev, ...updated }));
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <p>Loading settings...</p>;

  return (
    <div>
      <h1>Settings</h1>

      <div className="settings-layout">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={"settings-nav-link" + (section === s.id ? " active" : "")}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === "general" && (
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
              markDirty={markDirty}
            />
          )}

          {section === "collections" && (
            <SettingsCollections
              collections={collections}
              isCollectionEnabled={isCollectionEnabled}
              toggleCollection={toggleCollection}
              checkAllCollections={checkAllCollections}
              uncheckAllCollections={uncheckAllCollections}
            />
          )}

          {section === "keys" && <SettingsKeys settings={settings} />}

          {error && <p className="error">Error: {error}</p>}
          {saved && <p className="success">Settings saved.</p>}

          {section !== "keys" && (
            <button onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save settings"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
