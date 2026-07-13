import { useState } from "react";
import api from "../../services/api.js";
import Card from "../../components/Card.jsx";
import { useAuth } from "../../context/AuthContext.jsx";

const labelClass = "flex flex-col gap-1 text-sm font-medium text-ink-soft";
const inputClass =
  "w-80 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const hintClass = "text-xs text-ink-faint";

/**
 * Optional, per-account LLM connection -- its own tab rather than a sub-
 * section of Slug handling, since it's meant to power more than one
 * feature over time (e.g. a future "run a marketing prompt after
 * translation" action). Today it powers exactly one thing: Slug handling's
 * "Transliterate" mode falls back to this for scripts the built-in
 * Cyrillic/Greek map can't handle (Korean, Japanese, Chinese, Arabic,
 * Hebrew, etc). Connecting a key here changes nothing on its own until a
 * feature that uses it is turned on elsewhere.
 */
export default function SettingsLlm({ llmConnected, llmApiKeyMasked, onChange }) {
  const { canEdit } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveLlmConnection(apiKey);
      setApiKey("");
      setSaved(true);
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.deleteLlmConnection();
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[13.5px] font-semibold text-ink">LLM connectors</h2>

      {llmConnected && llmApiKeyMasked && (
        <p className="mb-3 text-sm text-ink-soft">
          Connected as <strong className="font-mono text-ink">{llmApiKeyMasked}</strong>
        </p>
      )}

      <label className={labelClass}>
        Anthropic API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={llmConnected ? "Enter a new key to change it" : "sk-ant-..."}
          className={inputClass}
        />
      </label>

      <p className={`mt-2 ${hintClass}`}>
        Connect once here, then use it from wherever it applies. Right now that's{" "}
        <strong className="text-ink-soft">Slug handling</strong>'s "Transliterate" mode, as a fallback for
        scripts the built-in transliteration can't handle on its own (Korean, Japanese, Chinese, Arabic,
        Hebrew, etc.) — Latin, Cyrillic, and Greek are always handled locally without this. More features
        may use this connection later. Validated against Anthropic before saving.
      </p>

      {error && <p className="mt-2 text-sm font-medium text-status-error-fg">{error}</p>}
      {saved && <p className="mt-2 text-sm font-medium text-status-success-fg">LLM connection saved.</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !apiKey || !canEdit}
          title={!canEdit ? "Your account has read-only access." : undefined}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save & test connection"}
        </button>
        {llmConnected && llmApiKeyMasked && (
          <button
            type="button"
            onClick={disconnect}
            disabled={saving || !canEdit}
            title={!canEdit ? "Your account has read-only access." : undefined}
            className="text-sm font-medium text-status-error-fg hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Disconnect
          </button>
        )}
      </div>
    </Card>
  );
}
