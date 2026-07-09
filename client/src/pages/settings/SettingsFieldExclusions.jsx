import { useEffect, useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";
import { Disclosure, DisclosureRow } from "../../components/Disclosure.jsx";

const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

/**
 * Per-collection field-level translation exclusion -- lets a field (e.g. an
 * internal note or an id) be left out of what gets sent to wxrks, without
 * touching which collections/items are in scope at all (that's the wizard's
 * job now, see SendToWxrksModal.jsx). Was part of the removed Collections
 * tab (commit 8d3af2e) alongside the since-superseded collection sync
 * enable/disable toggle -- that part stays gone, but this one has no other
 * home in the app, so it's back on its own.
 */
export default function SettingsFieldExclusions() {
  const [collections, setCollections] = useState(null);
  const [fieldsByCollection, setFieldsByCollection] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getCollections()
      .then((res) => setCollections(res.collections || []))
      .catch((err) => setError(err.message));
  }, []);

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
    <Card className="p-5">
      <h2 className="mb-1 text-[13.5px] font-semibold text-ink">Field translation</h2>
      <p className="mb-3 text-xs text-ink-faint">
        Turn off specific fields per collection that shouldn't be sent for translation (e.g. internal notes, slugs, ids).
      </p>

      {error && <p className="mb-3 text-sm font-medium text-status-error-fg">{error}</p>}
      {collections === null && <p className="text-sm text-ink-soft">Loading collections...</p>}
      {collections?.length === 0 && <p className="text-sm text-ink-faint">No collections found.</p>}

      <div className="flex flex-col gap-2">
        {collections?.map((collection) => {
          const fields = fieldsByCollection[collection.id];
          return (
            <Disclosure
              key={collection.id}
              summary={collection.displayName || collection.singularName}
              onOpen={() => loadFields(collection.id)}
              defaultOpen={false}
            >
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
          );
        })}
      </div>
    </Card>
  );
}
