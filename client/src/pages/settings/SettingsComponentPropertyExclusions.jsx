import { useEffect, useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";
import { Disclosure, DisclosureRow } from "../../components/Disclosure.jsx";
import { useAuth } from "../../context/AuthContext.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

/**
 * Per-component Property-level translation exclusion -- the direct analogue
 * of SettingsFieldExclusions.jsx for Component Properties. Unlike CMS
 * fields, Webflow's Property type (Plain Text/Rich Text/Alt Text) carries
 * no signal distinguishing real translatable text (e.g. a "Quote" property)
 * from a config value that merely happens to use the same type (e.g. a
 * "Logo width" property holding "48px", a "Style" property holding raw
 * CSS) -- so every property here is manually togglable, with no
 * type-based "not eligible" disabled state the way CMS fields get.
 */
export default function SettingsComponentPropertyExclusions() {
  const { canEdit } = useAuth();
  const [components, setComponents] = useState(null);
  const [propertiesByComponent, setPropertiesByComponent] = useState({});
  const [error, setError] = useState(null);

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

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-[13.5px] font-semibold text-ink">Component property translation</h2>
      <p className="mb-3 text-xs text-ink-faint">
        Turn off specific Properties per component that shouldn't be sent for translation (e.g. a "Logo width" or
        "Style" property holding a config value rather than real text).
      </p>

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
                        disabled={!canEdit}
                        onChange={() => togglePropertyExcluded(component.id, property.propertyId)}
                        label={`Translate ${property.label}`}
                      />
                    }
                  >
                    <span className="font-medium">{property.label}</span>{" "}
                    <span className="text-ink-faint">— {property.type}</span>
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
