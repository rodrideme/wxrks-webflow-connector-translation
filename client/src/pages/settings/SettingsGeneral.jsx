import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";

const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const selectClass =
  "w-72 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";
const linkButtonClass = "text-xs font-medium text-accent-text hover:underline";

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
}) {
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">wxrks org unit</h2>
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
          <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3 text-sm">
            {orgUnitResourcesLoading && <p className={hintClass}>Loading translation memories &amp; glossaries...</p>}
            {orgUnitResources && (
              <>
                <p className="text-ink-soft">
                  <strong className="text-ink">Translation memories:</strong>{" "}
                  {orgUnitResources.translationMemories.length === 0
                    ? "none bound to this org unit"
                    : orgUnitResources.translationMemories.map((tm) => tm.name).join(", ")}
                </p>
                <p className="mt-1 text-ink-soft">
                  <strong className="text-ink">Glossaries:</strong>{" "}
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
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Locales</h2>
        <p className="text-sm text-ink-soft">
          Source locale (fixed by your Webflow site config):{" "}
          <strong className="text-ink">{webflowLocales?.primary?.displayName || settings.sourceLocale}</strong>
        </p>

        <fieldset className="mt-4">
          <legend className="mb-1 text-sm font-semibold text-ink">Target locales</legend>
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
          <div className="flex flex-wrap gap-x-5 gap-y-2.5">
            {(webflowLocales?.secondary || []).map((locale) => (
              <label key={locale.tag} className="inline-flex items-center gap-2 text-sm text-ink-soft">
                <Toggle
                  checked={settings.targetLocales.includes(locale.tag)}
                  onChange={() => toggleTargetLocale(locale.tag)}
                  label={`${locale.displayName} (${locale.tag})`}
                />
                {locale.displayName} <span className="font-mono text-xs text-ink-faint">{locale.tag}</span>
              </label>
            ))}
          </div>
          {!webflowLocales && <p className={hintClass}>Could not load Webflow's configured locales.</p>}
        </fieldset>
        <p className={`mt-3 ${hintClass}`}>
          Only locales actually enabled on your Webflow site are shown here — Webflow silently falls back
          to the primary locale for anything else, so free-typed codes aren't offered.
        </p>
      </Card>
    </div>
  );
}
