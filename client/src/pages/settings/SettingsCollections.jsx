import { useState } from "react";
import api from "../../services/api.js";
import StatusBadge from "../../components/StatusBadge.jsx";

export default function SettingsCollections({
  collections,
  isCollectionEnabled,
  toggleCollection,
  checkAllCollections,
  uncheckAllCollections,
}) {
  const [expanded, setExpanded] = useState(null);
  const [itemsByCollection, setItemsByCollection] = useState({});
  const [configuring, setConfiguring] = useState(null);
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [error, setError] = useState(null);

  async function toggleExpand(collectionId) {
    if (expanded === collectionId) {
      setExpanded(null);
      return;
    }
    setExpanded(collectionId);
    if (!itemsByCollection[collectionId]) {
      try {
        const res = await api.getCollectionItems(collectionId);
        setItemsByCollection((prev) => ({ ...prev, [collectionId]: res.items }));
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function toggleConfigure(collectionId) {
    if (configuring === collectionId) {
      setConfiguring(null);
      return;
    }
    setConfiguring(collectionId);
    if (!fieldsByCollection[collectionId]) {
      try {
        const res = await api.getCollectionFields(collectionId);
        setFieldsByCollection((prev) => ({ ...prev, [collectionId]: res.fields }));
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function toggleFieldExcluded(collectionId, slug) {
    const fields = fieldsByCollection[collectionId];
    const updatedFields = fields.map((f) => (f.slug === slug ? { ...f, excluded: !f.excluded } : f));
    setFieldsByCollection((prev) => ({ ...prev, [collectionId]: updatedFields }));

    const excludedFields = updatedFields.filter((f) => f.excluded).map((f) => f.slug);
    try {
      await api.updateFieldExclusions(collectionId, excludedFields);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      {error && <p className="error">Error: {error}</p>}
      {collections.length > 0 && (
        <p>
          <button type="button" className="link-button" onClick={checkAllCollections}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className="link-button" onClick={uncheckAllCollections}>
            Uncheck all
          </button>
        </p>
      )}
      {collections.length === 0 && <p className="hint">No collections found.</p>}

      {collections.map((collection) => (
        <section className="card" key={collection.id}>
          <div className="collection-header-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={isCollectionEnabled(collection.id)}
                onChange={() => toggleCollection(collection.id)}
              />
              Sync this collection
            </label>
            <button className="collection-header" onClick={() => toggleExpand(collection.id)}>
              {collection.displayName || collection.singularName} {expanded === collection.id ? "▾" : "▸"}
            </button>
            <button className="link-button" onClick={() => toggleConfigure(collection.id)}>
              {configuring === collection.id ? "Hide field config" : "Configure translatable fields"}
            </button>
          </div>

          {configuring === collection.id && (
            <table className="items-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Translate?</th>
                </tr>
              </thead>
              <tbody>
                {(fieldsByCollection[collection.id] || []).map((field) => (
                  <tr key={field.slug}>
                    <td>{field.displayName}</td>
                    <td>{field.type}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={!field.excluded}
                        disabled={!field.translatableByDefault}
                        onChange={() => toggleFieldExcluded(collection.id, field.slug)}
                      />
                      {!field.translatableByDefault && <span className="hint"> (not text, fixed)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {expanded === collection.id && (
            <table className="items-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Last updated</th>
                  <th>Locale status</th>
                </tr>
              </thead>
              <tbody>
                {(itemsByCollection[collection.id] || []).map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.lastUpdated ? new Date(item.lastUpdated).toLocaleDateString() : "-"}</td>
                    <td>
                      {Object.entries(item.localeStatus || {}).map(([locale, status]) => (
                        <span key={locale} className="locale-status">
                          {locale}: <StatusBadge status={status} />
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
