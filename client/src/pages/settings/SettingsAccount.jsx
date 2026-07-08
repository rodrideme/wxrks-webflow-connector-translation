import Card from "../../components/Card.jsx";
import Toggle from "../../components/Toggle.jsx";

function buildPreviewName(pattern, token) {
  const name = (pattern || "").replace(/{collection}/g, "blog").replace(/{entry}/g, "name-of-the-entry").replace(/{page}/g, token).replace(/{component}/g, token).replace(/{field}/g, "");
  return `${name}.json`;
}

const FALLBACK_TIMEZONES = ["UTC", "America/Sao_Paulo", "America/New_York", "Europe/London", "Europe/Rome"];

function listTimezones() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const selectClass =
  "w-72 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const inputClass =
  "w-80 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";
const codeClass = "rounded bg-surface-sunken px-1 py-0.5 font-mono";

/**
 * App-level configuration: timezone, the 3 work-unit naming patterns (CMS/
 * Pages/Components), and the 2 automation toggles. Split out from
 * SettingsGeneral (which moved to Templates.jsx along with org unit/locales/
 * collections/pages/components/auto-sync) since these are app-behavior
 * concerns, not "what gets translated" concerns.
 */
export default function SettingsAccount({ settings, markDirty }) {
  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Timezone</h2>
        <label className={labelClass}>
          Timezone:
          <select
            value={settings.timezone}
            onChange={(e) => markDirty({ timezone: e.target.value })}
            className={selectClass}
          >
            {listTimezones().map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <p className={`mt-1 ${hintClass}`}>
          Used for Auto Sync's flush times (Templates → Auto Sync) and every date/time shown throughout this
          app, so everyone viewing it sees the same wall-clock time regardless of their own browser's zone.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Work unit naming</h2>
        <div className="flex flex-col gap-4">
          <div>
            <label className={labelClass}>
              CMS items:
              <input
                type="text"
                value={settings.workUnitNamePattern}
                onChange={(e) => markDirty({ workUnitNamePattern: e.target.value })}
                className={inputClass}
              />
            </label>
            <p className={`mt-1 ${hintClass}`}>
              Placeholders: <code className={codeClass}>{"{collection}"}</code>,{" "}
              <code className={codeClass}>{"{entry}"}</code>. Preview:{" "}
              <strong className="text-ink">{buildPreviewName(settings.workUnitNamePattern, "name-of-the-entry")}</strong>
            </p>
          </div>
          <div>
            <label className={labelClass}>
              Pages:
              <input
                type="text"
                value={settings.pagesWorkUnitNamePattern}
                onChange={(e) => markDirty({ pagesWorkUnitNamePattern: e.target.value })}
                className={inputClass}
              />
            </label>
            <p className={`mt-1 ${hintClass}`}>
              Placeholder: <code className={codeClass}>{"{page}"}</code>. Preview:{" "}
              <strong className="text-ink">{buildPreviewName(settings.pagesWorkUnitNamePattern, "pricing")}</strong>
            </p>
          </div>
          <div>
            <label className={labelClass}>
              Components:
              <input
                type="text"
                value={settings.componentsWorkUnitNamePattern}
                onChange={(e) => markDirty({ componentsWorkUnitNamePattern: e.target.value })}
                className={inputClass}
              />
            </label>
            <p className={`mt-1 ${hintClass}`}>
              Placeholder: <code className={codeClass}>{"{component}"}</code>. Preview:{" "}
              <strong className="text-ink">{buildPreviewName(settings.componentsWorkUnitNamePattern, "footer")}</strong>
            </p>
          </div>
        </div>
        <p className={`mt-4 ${hintClass}`}>
          These become the wxrks resource/work-unit names. Keep the entity's own placeholder in each
          pattern so names stay unique within a project.
        </p>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Automation</h2>
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <Toggle
            checked={settings.autoApprove}
            onChange={(e) => markDirty({ autoApprove: e.target.checked })}
            label="Auto-approve wxrks projects"
          />
          Auto-approve wxrks projects (skip manual approval so translation starts immediately)
        </label>
        <label className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
          <Toggle
            checked={settings.autoPublish}
            onChange={(e) => markDirty({ autoPublish: e.target.checked })}
            label="Auto-publish translated Webflow items"
          />
          Auto-publish translated Webflow items (otherwise leave as Draft)
        </label>
      </Card>
    </div>
  );
}
