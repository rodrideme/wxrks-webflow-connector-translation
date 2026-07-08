import { useState } from "react";
import api from "../../services/api.js";
import { formatDateOnly } from "../../formatDate.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";
import StatusPill from "../../components/StatusPill.jsx";
import { Disclosure, DisclosureRow } from "../../components/Disclosure.jsx";
import { localeStatusPill } from "../../statusHelpers.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

export default function SettingsCollections({ collections, isCollectionEnabled, toggleCollection, checkAllCollections, uncheckAllCollections, timezone }) {
  const [itemsByCollection, setItemsByCollection] = useState({});
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [error, setError] = useState(null);

  async function loadItems(collectionId) {
    if (itemsByCollection[collectionId]) return;
    try {
      const res = await api.getCollectionItems(collectionId);
      setItemsByCollection((prev) => ({ ...prev, [collectionId]: res.items }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadFields(collectionId) {
    if (fieldsByCollection[collectionId]) return;
    try {
      const res = await api.getCollectionFields(collectionId);
      setFieldsByCollection((prev) => ({ ...prev, [collectionId]: res.fields }));
    } catch (err) {
      setError(err.message);
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
      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">Error: {error}</p>}
      {collections.length > 0 && (
        <p className="mb-4 text-sm text-ink-soft">
          <button type="button" className={linkButtonClass} onClick={checkAllCollections}>
            Check all
          </button>{" "}
          ·{" "}
          <button type="button" className={linkButtonClass} onClick={uncheckAllCollections}>
            Uncheck all
          </button>
        </p>
      )}
      {collections.length === 0 && <p className="text-sm text-ink-faint">No collections found.</p>}

      <div className="flex flex-col gap-4">
        {collections.map((collection) => {
          const fields = fieldsByCollection[collection.id];
          const items = itemsByCollection[collection.id];
          return (
            <Card key={collection.id} className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-ink-soft">
                  <Toggle
                    checked={isCollectionEnabled(collection.id)}
                    onChange={() => toggleCollection(collection.id)}
                    label="Sync this collection"
                  />
                  Sync this collection
                </label>
                <span className="ml-auto text-base font-semibold text-ink">
                  {collection.displayName || collection.singularName}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <Disclosure summary="Translatable fields" onOpen={() => loadFields(collection.id)} defaultOpen={false}>
                  {!fields ? (
                    <DisclosureRow>
                      <button className={linkButtonClass} onClick={() => loadFields(collection.id)}>
                        Load fields
                      </button>
                    </DisclosureRow>
                  ) : (
                    fields.map((field) => (
                      <DisclosureRow
                        key={field.slug}
                        trailing={
                          <Toggle
                            checked={!field.excluded}
                            disabled={!field.translatableByDefault}
                            onChange={() => toggleFieldExcluded(collection.id, field.slug)}
                            label={`Translate ${field.displayName}`}
                          />
                        }
                      >
                        <span className="font-medium">{field.displayName}</span>{" "}
                        <span className="text-ink-faint">— {field.type}</span>
                        {!field.translatableByDefault && <span className="ml-1 text-ink-faint">(not text, fixed)</span>}
                      </DisclosureRow>
                    ))
                  )}
                </Disclosure>

                <Disclosure summary="Items" meta={items ? `${items.length} items` : undefined} onOpen={() => loadItems(collection.id)}>
                  {!items ? (
                    <DisclosureRow>
                      <button className={linkButtonClass} onClick={() => loadItems(collection.id)}>
                        Load items
                      </button>
                    </DisclosureRow>
                  ) : items.length === 0 ? (
                    <DisclosureRow>
                      <span className="text-ink-faint">No items in this collection.</span>
                    </DisclosureRow>
                  ) : (
                    items.map((item) => (
                      <DisclosureRow
                        key={item.id}
                        trailing={
                          <div className="flex flex-wrap items-center gap-1.5">
                            {Object.entries(item.localeStatus || {}).map(([locale, status]) => (
                              <span key={locale} className="inline-flex items-center gap-1 text-xs text-ink-faint">
                                {locale}
                                {localeStatusPill(status)}
                              </span>
                            ))}
                          </div>
                        }
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{item.name}</span>
                          <span className="font-mono text-xs text-ink-faint">{formatDateOnly(item.lastPublished, timezone)}</span>
                          {item.isArchived ? (
                            <StatusPill variant="draft" label="Archived" />
                          ) : item.isDraft ? (
                            <StatusPill variant="progress" label="Draft" />
                          ) : null}
                        </div>
                      </DisclosureRow>
                    ))
                  )}
                </Disclosure>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
