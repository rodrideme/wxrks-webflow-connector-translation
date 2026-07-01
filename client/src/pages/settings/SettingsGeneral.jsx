function buildPreviewName(pattern) {
  const name = (pattern || "")
    .replace(/{collection}/g, "blog")
    .replace(/{entry}/g, "name-of-the-entry")
    .replace(/{field}/g, "");
  return `${name}.json`;
}

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
      <section className="card">
        <h2>wxrks org unit</h2>
        <label>
          Org unit:
          <select value={settings.orgUnitUUID || ""} onChange={(e) => selectOrgUnit(e.target.value)}>
            <option value="">Select an org unit</option>
            {orgUnits.map((o) => (
              <option key={o.uuid} value={o.uuid}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">Projects and work units are created under this org unit in wxrks.</p>

        {settings.orgUnitUUID && (
          <div>
            {orgUnitResourcesLoading && <p className="hint">Loading translation memories &amp; glossaries...</p>}
            {orgUnitResources && (
              <>
                <p>
                  <strong>Translation memories:</strong>{" "}
                  {orgUnitResources.translationMemories.length === 0
                    ? "none bound to this org unit"
                    : orgUnitResources.translationMemories.map((tm) => tm.name).join(", ")}
                </p>
                <p>
                  <strong>Glossaries:</strong>{" "}
                  {orgUnitResources.glossaries.length === 0
                    ? "none bound to this org unit"
                    : orgUnitResources.glossaries.map((g) => g.name).join(", ")}
                </p>
                <p className="hint">
                  Read-only — wxrks attaches these to each project automatically based on the org unit.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Locales</h2>
        <p>
          Source locale (fixed by your Webflow site config):{" "}
          <strong>{webflowLocales?.primary?.displayName || settings.sourceLocale}</strong>
        </p>

        <fieldset>
          <legend>Target locales</legend>
          {webflowLocales?.secondary?.length > 0 && (
            <p>
              <button type="button" className="link-button" onClick={checkAllTargetLocales}>
                Check all
              </button>{" "}
              ·{" "}
              <button type="button" className="link-button" onClick={uncheckAllTargetLocales}>
                Uncheck all
              </button>
            </p>
          )}
          {(webflowLocales?.secondary || []).map((locale) => (
            <label key={locale.tag} className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.targetLocales.includes(locale.tag)}
                onChange={() => toggleTargetLocale(locale.tag)}
              />
              {locale.displayName} ({locale.tag})
            </label>
          ))}
          {!webflowLocales && <p className="hint">Could not load Webflow's configured locales.</p>}
        </fieldset>
        <p className="hint">
          Only locales actually enabled on your Webflow site are shown here — Webflow silently falls back
          to the primary locale for anything else, so free-typed codes aren't offered.
        </p>
      </section>

      <section className="card">
        <h2>Work unit naming</h2>
        <label>
          Pattern:
          <input
            type="text"
            value={settings.workUnitNamePattern}
            onChange={(e) => markDirty({ workUnitNamePattern: e.target.value })}
            style={{ width: "320px", marginLeft: "0.5rem" }}
          />
        </label>
        <p className="hint">
          Placeholders: <code>{"{collection}"}</code>, <code>{"{entry}"}</code>.
          Preview: <strong>{buildPreviewName(settings.workUnitNamePattern)}</strong>
        </p>
        <p className="hint">
          This becomes the wxrks resource/work-unit name — one per Webflow entry (all its translatable
          fields bundled together). Keep <code>{"{entry}"}</code> in the pattern so names stay unique
          within a project.
        </p>
      </section>

      <section className="card">
        <h2>Automation</h2>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={(e) => markDirty({ autoApprove: e.target.checked })}
          />
          Auto-approve wxrks projects (skip manual approval so translation starts immediately)
        </label>
        <br />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.autoPublish}
            onChange={(e) => markDirty({ autoPublish: e.target.checked })}
          />
          Auto-publish translated Webflow items (otherwise leave as Draft)
        </label>
      </section>
    </>
  );
}
