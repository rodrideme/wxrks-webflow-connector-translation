import { useEffect, useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

export default function SettingsComponents({ settings, markDirty }) {
  const [components, setComponents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getComponents()
      .then((res) => setComponents(res.components || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function isComponentEnabled(componentId) {
    return settings.components.allComponentsEnabled || settings.components.enabledComponentIds.includes(componentId);
  }

  function toggleComponent(componentId) {
    const { components: componentsSettings } = settings;
    if (componentsSettings.allComponentsEnabled) {
      // Materialize: everything was implicitly enabled -- switch to an
      // explicit list of everything except the one just unchecked.
      const allIds = components.map((c) => c.id);
      markDirty({
        components: {
          ...componentsSettings,
          allComponentsEnabled: false,
          enabledComponentIds: allIds.filter((id) => id !== componentId),
        },
      });
      return;
    }
    const enabledComponentIds = componentsSettings.enabledComponentIds.includes(componentId)
      ? componentsSettings.enabledComponentIds.filter((id) => id !== componentId)
      : [...componentsSettings.enabledComponentIds, componentId];
    markDirty({ components: { ...componentsSettings, enabledComponentIds } });
  }

  function checkAll() {
    markDirty({ components: { ...settings.components, allComponentsEnabled: true, enabledComponentIds: [] } });
  }

  function uncheckAll() {
    markDirty({ components: { ...settings.components, allComponentsEnabled: false, enabledComponentIds: [] } });
  }

  if (loading) return <p className="text-sm text-ink-soft">Loading components...</p>;

  return (
    <div>
      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">Error: {error}</p>}
      {components.length > 0 && (
        <p className="mb-3 text-sm text-ink-soft">
          <button type="button" className={linkButtonClass} onClick={checkAll}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className={linkButtonClass} onClick={uncheckAll}>
            Uncheck all
          </button>
          {" — manual sync. Translates each component's definition once -- the translation applies everywhere it's used."}
        </p>
      )}
      {components.length === 0 && <p className="text-sm text-ink-faint">No components found.</p>}

      <Card>
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] font-bold uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="whitespace-nowrap px-3.5 py-2">Sync</th>
                <th className="whitespace-nowrap px-3 py-2">Component</th>
                <th className="whitespace-nowrap px-3 py-2">Group</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {components.map((component) => (
                <tr key={component.id} className="hover:bg-surface-sunken">
                  <td className="px-3.5 py-2.5">
                    <Toggle
                      checked={isComponentEnabled(component.id)}
                      onChange={() => toggleComponent(component.id)}
                      label={component.name}
                    />
                  </td>
                  <td className="px-3 py-2.5 font-medium text-ink">{component.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{component.group || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
