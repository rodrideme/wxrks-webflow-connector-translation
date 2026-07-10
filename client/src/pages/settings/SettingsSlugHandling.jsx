import { useState } from "react";
import Card from "../../components/Card.jsx";

const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const selectClass =
  "w-72 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const inputClass =
  "w-32 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";

/**
 * Controls whether/how a CMS item's Webflow slug is regenerated for each
 * target locale on write-back (see routes/webhooks.js's wxrks-webhook
 * handler and store.js's slugHandling default). Slugs themselves are never
 * sent to wxrks for translation -- the candidate is always derived locally
 * from the item's name -- so this only ever changes what happens after a
 * normal translation completes. Always applied automatically, no review
 * step, so this is the single, self-contained on/off + tuning control.
 */
export default function SettingsSlugHandling({ settings, markDirty, saveFields }) {
  const slugHandling = settings.slugHandling;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  function patchSlugHandling(patch) {
    markDirty({ slugHandling: { ...slugHandling, ...patch } });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await saveFields(["slugHandling"]);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[13.5px] font-semibold text-ink">Slug handling</h2>
      <p className={hintClass}>
        Slugs matter for SEO and usability, so translated content doesn't have to keep the source-language
        slug. Webflow requires dashes (not underscores) and a lowercase, URL-safe format — this app enforces
        that automatically any time it writes a new slug, regardless of the mode below. A new slug is always
        applied automatically as soon as translation completes — there's no manual review step.
      </p>

      <label className={`mt-4 ${labelClass}`}>
        Target-locale slugs:
        <select
          value={slugHandling.mode}
          onChange={(e) => patchSlugHandling({ mode: e.target.value })}
          className={selectClass}
        >
          <option value="source">Keep the source slug</option>
          <option value="translate">Translate (derived from the translated name)</option>
          <option value="transliterate">Transliterate (romanized version of the translated name)</option>
        </select>
      </label>

      {slugHandling.mode !== "source" && (
        <div className="mt-4 border-t border-border pt-4">
          <label className={labelClass}>
            Max length (characters):
            <input
              type="number"
              min={20}
              max={200}
              value={slugHandling.maxLength}
              onChange={(e) => patchSlugHandling({ maxLength: Number(e.target.value) })}
              className={inputClass}
            />
          </label>
          {slugHandling.mode === "transliterate" && (
            <p className={`mt-2 ${hintClass}`}>
              For scripts the built-in transliteration can't handle (Korean, Japanese, Chinese, Arabic,
              Hebrew, etc.), connect an LLM under "LLM connectors" as a fallback.
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-status-error-fg">{error}</p>}
      {saved && <p className="mt-3 text-sm font-medium text-status-success-fg">Saved.</p>}

      <button
        onClick={save}
        disabled={saving}
        className="mt-4 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save settings"}
      </button>
    </Card>
  );
}
