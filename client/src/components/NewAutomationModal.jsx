import { useEffect, useState } from "react";
import api from "../services/api.js";
import Modal from "./Modal.jsx";
import SegmentedControl from "./SegmentedControl.jsx";
import SyncSidebar from "./SyncSidebar.jsx";
import ScheduleEditor from "./ScheduleEditor.jsx";
import CmsAutomationScopeEditor from "./CmsAutomationScopeEditor.jsx";
import PagesFolderPicker from "./PagesFolderPicker.jsx";
import { Disclosure } from "./Disclosure.jsx";

const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink-faint";

const SCOPE_OPTIONS = [
  { value: "all", label: "All Content" },
  { value: "cms", label: "CMS" },
  { value: "pages", label: "Pages" },
  { value: "components", label: "Components" },
];

function defaultScopeFor(type) {
  if (type === "cms") return { type: "cms", allCollectionsEnabled: false, enabledCollectionIds: [], fieldConditions: {} };
  if (type === "pages") return { type: "pages", pageFolderIds: [] };
  if (type === "components") return { type: "components" };
  return { type: "all" };
}

function scopeSummary(scope) {
  if (scope.type === "all") return "All content";
  if (scope.type === "cms") {
    return scope.allCollectionsEnabled ? "All collections" : `${scope.enabledCollectionIds.length} collection(s)`;
  }
  if (scope.type === "pages") return `${scope.pageFolderIds.length} folder(s)`;
  return "All components";
}

/**
 * Create/edit form for one automation, in a single scrollable form (not a
 * literal paginated Back/Next wizard -- this app's existing convention for
 * multi-section config, per Templates.jsx, is one scrollable form with a
 * single Save). Pass `automation` to edit an existing one; omit to create.
 */
export default function NewAutomationModal({ open, onClose, onSaved, automation }) {
  const [name, setName] = useState("");
  const [contentScope, setContentScope] = useState(defaultScopeFor("all"));
  const [flushTimes, setFlushTimes] = useState(["00:00", "12:00"]);
  const [orgUnitOverride, setOrgUnitOverride] = useState("");

  const [settings, setSettings] = useState(null);
  const [orgUnits, setOrgUnits] = useState([]);
  const [collections, setCollections] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.getSettings().then(setSettings);
    api.getOrgUnits().then((res) => setOrgUnits(res.orgUnits || [])).catch(() => {});
    api.getCollections().then((res) => setCollections(res.collections || [])).catch(() => {});

    if (automation) {
      setName(automation.name);
      setContentScope(automation.contentScope);
      setFlushTimes(automation.flushTimes);
      setOrgUnitOverride(automation.orgUnitOverride || "");
    } else {
      setName("");
      setContentScope(defaultScopeFor("all"));
      setFlushTimes(["00:00", "12:00"]);
      setOrgUnitOverride("");
    }
    setError(null);
  }, [open, automation]);

  function orgUnitName(uuid) {
    const o = orgUnits.find((o) => o.uuid === uuid);
    return o ? o.name : uuid;
  }

  const effectiveOrgUnitUUID = orgUnitOverride || settings?.orgUnitUUID;
  const orgUnitLabel = effectiveOrgUnitUUID ? orgUnitName(effectiveOrgUnitUUID) : "not set";

  async function handleSave() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), contentScope, flushTimes, orgUnitOverride: orgUnitOverride || null };
      if (automation) {
        await api.updateAutomation(automation.id, payload);
      } else {
        await api.createAutomation(payload);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={automation ? "Edit automation" : "New automation"} width="max-w-4xl">
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1 space-y-5">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-soft">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Blog auto-translate"
              className={inputClass}
            />
          </label>

          <div>
            <div className="mb-2 text-sm font-medium text-ink-soft">Pick the content</div>
            <SegmentedControl
              options={SCOPE_OPTIONS}
              value={contentScope.type}
              onChange={(type) => setContentScope(defaultScopeFor(type))}
            />
          </div>

          {contentScope.type === "all" && (
            <p className="text-sm text-ink-faint">
              Every CMS collection, page, and component -- any qualifying publish or edit is translated automatically.
            </p>
          )}

          {contentScope.type === "cms" && (
            <CmsAutomationScopeEditor value={contentScope} onChange={setContentScope} collections={collections} />
          )}

          {contentScope.type === "pages" && (
            <div>
              <p className="mb-2 text-sm text-ink-faint">Select which folders qualify.</p>
              <PagesFolderPicker
                value={contentScope.pageFolderIds}
                onChange={(pageFolderIds) => setContentScope({ ...contentScope, pageFolderIds })}
              />
            </div>
          )}

          {contentScope.type === "components" && (
            <p className="text-sm text-ink-faint">
              Every component definition -- any modification is translated automatically (components have no
              sub-grouping to scope by).
            </p>
          )}

          <div>
            <div className="mb-2 text-sm font-medium text-ink-soft">Send schedule</div>
            <ScheduleEditor flushTimes={flushTimes} onChange={setFlushTimes} timezone={settings?.timezone || "UTC"} />
          </div>

          <Disclosure summary="Advanced settings">
            <div className="px-3.5 py-3">
              <label className="flex flex-col gap-1 text-sm font-medium text-ink-soft">
                Org unit override
                <select value={orgUnitOverride} onChange={(e) => setOrgUnitOverride(e.target.value)} className={inputClass}>
                  <option value="">(use global org unit)</option>
                  {orgUnits.map((o) => (
                    <option key={o.uuid} value={o.uuid}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Disclosure>

          {error && <p className="text-sm font-medium text-status-error-fg">Error: {error}</p>}
        </div>

        <SyncSidebar orgUnitName={orgUnitLabel} targetLocales={settings?.targetLocales} volumeLabel={scopeSummary(contentScope)}>
          <button type="button" onClick={onClose} className={btnGhost + " w-full"}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className={btnPrimary + " w-full"}>
            {saving ? "Saving..." : automation ? "Save changes" : "Create automation"}
          </button>
        </SyncSidebar>
      </div>
    </Modal>
  );
}
