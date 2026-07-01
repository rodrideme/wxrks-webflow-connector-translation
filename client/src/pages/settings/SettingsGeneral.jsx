function buildPreviewName(pattern) {
  const name = (pattern || "")
    .replace(/{collection}/g, "blog")
    .replace(/{entry}/g, "name-of-the-entry")
    .replace(/{field}/g, "");
  return `${name}.json`;
}

const cardClass = "mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm";
const labelClass = "flex flex-col gap-1 text-sm font-medium text-slate-700";
const selectClass =
  "w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";
const hintClass = "text-xs text-slate-500";
const linkButtonClass = "text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline";

export default function SettingsGeneral({
  settings,
  orgUnits,
  webflowLocales,
  orgUnitResources,
  orgUnitResourcesLoading,
  selectOrgUnit,
  toggleTargetLocale,
  checkAllTargetLocales,
  uncheckAllTargetLocales,
  markDirty,
}) {
  return (
    <>
      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">wxrks org unit</h2>
        <label className={labelClass}>
          Org unit:
          <select value={settings.orgUnitUUID || ""} onChange={(e) => selectOrgUnit(e.target.value)} className={selectClass}>
            <option value="">Select an org unit</option>
            {orgUnits.map((o) => (
              <option key={o.uuid} value={o.uuid}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <p className={`mt-1 ${hintClass}`}>Projects and work units are created under this org unit in wxrks.</p>

        {settings.orgUnitUUID && (
          <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
            {orgUnitResourcesLoading && <p className={hintClass}>Loading translation memories &amp; glossaries...</p>}
            {orgUnitResources && (
              <>
                <p className="text-slate-700">
                  <strong className="text-slate-900">Translation memories:</strong>{" "}
                  {orgUnitResources.translationMemories.length === 0
                    ? "none bound to this org unit"
                    : orgUnitResources.translationMemories.map((tm) => tm.name).join(", ")}
                </p>
                <p className="mt-1 text-slate-700">
                  <strong className="text-slate-900">Glossaries:</strong>{" "}
                  {orgUnitResources.glossaries.length === 0
                    ? "none bound to this org unit"
                    : orgUnitResources.glossaries.map((g) => g.name).join(", ")}
                </p>
                <p className={`mt-2 ${hintClass}`}>
                  Read-only — wxrks attaches these to each project automatically based on the org unit.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Locales</h2>
        <p className="text-sm text-slate-700">
          Source locale (fixed by your Webflow site config):{" "}
          <strong className="text-slate-900">{webflowLocales?.primary?.displayName || settings.sourceLocale}</strong>
        </p>

        <fieldset className="mt-4">
          <legend className="mb-1 text-sm font-semibold text-slate-900">Target locales</legend>
          {webflowLocales?.secondary?.length > 0 && (
            <p className="mb-2">
              <button type="button" className={linkButtonClass} onClick={checkAllTargetLocales}>
                Check all
              </button>{" "}
              ·{" "}
              <button type="button" className={linkButtonClass} onClick={uncheckAllTargetLocales}>
                Uncheck all
              </button>
            </p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {(webflowLocales?.secondary || []).map((locale) => (
              <label key={locale.tag} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.targetLocales.includes(locale.tag)}
                  onChange={() => toggleTargetLocale(locale.tag)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
                />
                {locale.displayName} ({locale.tag})
              </label>
            ))}
          </div>
          {!webflowLocales && <p className={hintClass}>Could not load Webflow's configured locales.</p>}
        </fieldset>
        <p className={`mt-3 ${hintClass}`}>
          Only locales actually enabled on your Webflow site are shown here — Webflow silently falls back
          to the primary locale for anything else, so free-typed codes aren't offered.
        </p>
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Work unit naming</h2>
        <label className={labelClass}>
          Pattern:
          <input
            type="text"
            value={settings.workUnitNamePattern}
            onChange={(e) => markDirty({ workUnitNamePattern: e.target.value })}
            className="w-80 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </label>
        <p className={`mt-2 ${hintClass}`}>
          Placeholders: <code className="rounded bg-slate-100 px-1 py-0.5">{"{collection}"}</code>,{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5">{"{entry}"}</code>. Preview:{" "}
          <strong className="text-slate-900">{buildPreviewName(settings.workUnitNamePattern)}</strong>
        </p>
        <p className={`mt-1 ${hintClass}`}>
          This becomes the wxrks resource/work-unit name — one per Webflow entry (all its translatable
          fields bundled together). Keep <code className="rounded bg-slate-100 px-1 py-0.5">{"{entry}"}</code> in the
          pattern so names stay unique within a project.
        </p>
      </section>

      <section className={cardClass}>
        <h2 className="mb-3 text-base font-semibold text-slate-900">Automation</h2>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={(e) => markDirty({ autoApprove: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
          />
          Auto-approve wxrks projects (skip manual approval so translation starts immediately)
        </label>
        <label className="mt-2 flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={settings.autoPublish}
            onChange={(e) => markDirty({ autoPublish: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500"
          />
          Auto-publish translated Webflow items (otherwise leave as Draft)
        </label>
      </section>
    </>
  );
}
