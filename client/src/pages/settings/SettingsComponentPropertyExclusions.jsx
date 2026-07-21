import { useEffect, useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";
import { Disclosure, DisclosureRow } from "../../components/Disclosure.jsx";
import { useAuth } from "../../context/AuthContext.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";
const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const inputClass =
  "w-full max-w-md rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";

/**
 * Per-component Property-level translation exclusion -- the direct analogue
 * of SettingsFieldExclusions.jsx for Component Properties. Unlike CMS
 * fields, Webflow's Property type (Plain Text/Rich Text/Alt Text) carries
 * no signal distinguishing real translatable text (e.g. a "Quote" property)
 * from a config value that merely happens to use the same type (e.g. a
 * "Logo width" property holding "48px", a "Style" property holding raw
 * CSS) -- so beyond the keyword auto-exclusion below, every property here
 * is manually togglable, with no type-based "not eligible" disabled state
 * the way CMS fields get.
 */
export default function SettingsComponentPropertyExclusions({ settings, markDirty }) {
  const { canEdit } = useAuth();
  const [components, setComponents] = useState(null);
  const [propertiesByComponent, setPropertiesByComponent] = useState({});
  const [error, setError] = useState(null);

  const [keywordsDraft, setKeywordsDraft] = useState((settings.componentPropertyAutoExcludeKeywords || []).join(", "));
  const [savingKeywords, setSavingKeywords] = useState(false);
  const [keywordsSaved, setKeywordsSaved] = useState(false);
  const [keywordsError, setKeywordsError] = useState(null);

  useEffect(() => {
    api
      .getComponents()
      .then((res) => setComponents(res.components || []))
      .catch((err) => setError(err.message));
  }, []);

  async function loadProperties(componentId) {
    if (propertiesByComponent[componentId]) return;
    try {
      const res = await api.getComponentProperties(componentId);
      setPropertiesByComponent((prev) => ({ ...prev, [componentId]: res.properties }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function togglePropertyExcluded(componentId, propertyId) {
    const properties = propertiesByComponent[componentId];
    const updatedProperties = properties.map((p) => (p.propertyId === propertyId ? { ...p, excluded: !p.excluded } : p));
    setPropertiesByComponent((prev) => ({ ...prev, [componentId]: updatedProperties }));

    const excludedPropertyIds = updatedProperties.filter((p) => p.excluded).map((p) => p.propertyId);
    try {
      await api.updateComponentPropertyExclusions(componentId, excludedPropertyIds);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveKeywords() {
    const keywords = keywordsDraft
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    setSavingKeywords(true);
    setKeywordsError(null);
    setKeywordsSaved(false);
    try {
      // Calls api.updateSettings directly with the exact patch, rather than
      // markDirty + saveFields(["..."]) (which reads the value back off the
      // parent's `settings` prop) -- markDirty's state update hasn't been
      // re-rendered into a new saveFields closure yet by the time this same
      // click handler would call it, so saveFields would read the OLD
      // (pre-edit) keywords instead of what was just typed.
      const updated = await api.updateSettings({ componentPropertyAutoExcludeKeywords: keywords });
      markDirty({ componentPropertyAutoExcludeKeywords: updated.componentPropertyAutoExcludeKeywords });
      setKeywordsSaved(true);
      // Force a re-fetch (bypassing loadProperties' cache guard, which
      // would otherwise see stale pre-update state and skip it) of every
      // already-loaded component's properties, so their excluded/
      // autoExcluded flags reflect the new keyword list immediately
      // instead of only on next expand.
      const loadedIds = Object.keys(propertiesByComponent);
      const refetched = await Promise.all(loadedIds.map((id) => api.getComponentProperties(id)));
      setPropertiesByComponent((prev) => {
        const next = { ...prev };
        loadedIds.forEach((id, i) => {
          next[id] = refetched[i].properties;
        });
        return next;
      });
    } catch (err) {
      setKeywordsError(err.message);
    } finally {
      setSavingKeywords(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-[13.5px] font-semibold text-ink">Component property translation</h2>
      <p className="mb-3 text-xs text-ink-faint">
        Turn off specific Properties per component that shouldn't be sent for translation (e.g. a "Logo width" or
        "Style" property holding a config value rather than real text).
      </p>

      <div className="mb-4 border-b border-border pb-4">
        <label className={labelClass}>
          Auto-exclude properties whose label contains (comma-separated):
          <input
            type="text"
            value={keywordsDraft}
            onChange={(e) => setKeywordsDraft(e.target.value)}
            placeholder="width, class, style"
            className={inputClass}
          />
        </label>
        <p className={`mt-1 ${hintClass}`}>
          Any property whose label contains one of these words (case-insensitive) is automatically excluded from
          translation, on top of the manual toggles below -- covers config-flavored properties without needing to
          find and turn off each one individually.
        </p>
        {keywordsError && <p className="mt-2 text-sm font-medium text-status-error-fg">{keywordsError}</p>}
        {keywordsSaved && <p className="mt-2 text-sm font-medium text-status-success-fg">Saved.</p>}
        <button
          onClick={saveKeywords}
          disabled={savingKeywords || !canEdit}
          title={!canEdit ? "Your account has read-only access." : undefined}
          className="mt-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {savingKeywords ? "Saving..." : "Save keywords"}
        </button>
      </div>

      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">{error}</p>}
      {components === null && <p className="text-sm text-ink-soft">Loading components...</p>}
      {components?.length === 0 && <p className="text-sm text-ink-faint">No components found.</p>}

      <div className="flex flex-col gap-2">
        {components?.map((component) => {
          const properties = propertiesByComponent[component.id];
          return (
            <Disclosure
              key={component.id}
              summary={component.name}
              onOpen={() => loadProperties(component.id)}
              defaultOpen={false}
            >
              {!properties ? (
                <DisclosureRow>
                  <button className={linkButtonClass} onClick={() => loadProperties(component.id)}>
                    Load properties
                  </button>
                </DisclosureRow>
              ) : properties.length === 0 ? (
                <DisclosureRow>
                  <span className="text-ink-faint">No properties on this component.</span>
                </DisclosureRow>
              ) : (
                properties.map((property) => (
                  <DisclosureRow
                    key={property.propertyId}
                    trailing={
                      <Toggle
                        checked={!property.excluded}
                        disabled={property.autoExcluded || !canEdit}
                        onChange={() => togglePropertyExcluded(component.id, property.propertyId)}
                        label={`Translate ${property.label}`}
                      />
                    }
                  >
                    <span className="font-medium">{property.label}</span>{" "}
                    <span className="text-ink-faint">— {property.type}</span>
                    {property.autoExcluded && <span className="ml-1 text-ink-faint">(auto-excluded by keyword)</span>}
                  </DisclosureRow>
                ))
              )}
            </Disclosure>
          );
        })}
      </div>
    </Card>
  );
}
